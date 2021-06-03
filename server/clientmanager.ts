import { Session } from "express-session";
import WebSocket from "ws";
import _ from "lodash";
import { wss } from "./websockets.js";
import { getLogger } from "../logger.js";
import { Request } from 'express';
import { redisClient, createSubscriber } from "../redisclient";
import { promisify } from "util";
import { ClientMessage, RoomRequest, RoomRequestType, ServerMessage, ServerMessageSync } from "../common/models/messages";
import { ClientNotFoundInRoomException, RoomNotFoundException } from "./exceptions";
import { ClientInfo, MySession, OttWebsocketError, ClientId, RoomStateSyncable } from "../common/models/types";
// WARN: do NOT import roommanager
import roommanager from "./roommanager"; // this is temporary because these modules are supposed to be completely isolated. In the future, it should send room requests via the HTTP API to other nodes.
import { ANNOUNCEMENT_CHANNEL } from "../common/constants";
import { uniqueNamesGenerator } from 'unique-names-generator';

const log = getLogger("clientmanager");
const redisSubscriber = createSubscriber();
const get = promisify(redisClient.get).bind(redisClient);
const subscribe: (channel: string) => Promise<string> = promisify(redisSubscriber.subscribe).bind(redisSubscriber);
const connections: Client[] = [];
const roomStates: Map<string, RoomStateSyncable> = new Map();
const roomJoins: Map<string, Client[]> = new Map();
subscribe(ANNOUNCEMENT_CHANNEL);

export class Client {
	id: ClientId
	Socket: WebSocket
	Session: MySession
	room: string | null

	constructor (session: MySession, socket: WebSocket) {
		this.id = _.uniqueId(); // maybe use uuidv4 from uuid package instead?
		this.Session = session;
		this.Socket = socket;
		this.room = null;

		this.Socket.on("close", async (code, reason) => {
			log.debug(`socket closed: ${code}, ${reason}`);
			const idx = _.findIndex(connections, { id: this.id });
			connections.splice(idx, 1);

			if (this.room) {
				const room = await roommanager.GetRoom(this.room);
				await room.processRequest({
					type: RoomRequestType.LeaveRequest,
					client: this.id,
				});
			}
		});
	}

	get clientInfo(): ClientInfo {
		if (this.Session.passport && this.Session.passport.user) {
			return {
				id: this.id,
				user_id: this.Session.passport.user,
			};
		}
		else if (this.Session.username) {
			return {
				id: this.id,
				username: this.Session.username,
			};
		}
		else {
			log.error("Session did not have username present, nor passport user id. Generating username...");
			return {
				id: this.id,
				username: uniqueNamesGenerator(),
			};
		}
	}

	public async OnMessage(text: string): Promise<void> {
		log.silly(`client message: ${text}`);
		const msg: ClientMessage = JSON.parse(text);
		let request: RoomRequest | null = null;
		if (msg.action === "play") {
			request = {
				type: RoomRequestType.PlaybackRequest,
				client: this.id,
				state: true,
			};
		}
		else if (msg.action === "pause") {
			request = {
				type: RoomRequestType.PlaybackRequest,
				client: this.id,
				state: false,
			};
		}
		else if (msg.action === "skip") {
			request = {
				type: RoomRequestType.SkipRequest,
				client: this.id,
			};
		}
		else if (msg.action === "seek") {
			request = {
				type: RoomRequestType.SeekRequest,
				client: this.id,
				value: msg.position,
			};
		}
		else if (msg.action === "queue-move") {
			request = {
				type: RoomRequestType.OrderRequest,
				client: this.id,
				fromIdx: msg.currentIdx,
				toIdx: msg.targetIdx,
			};
		}
		else if (msg.action === "kickme") {
			this.Socket.close(OttWebsocketError.UNKNOWN);
			return;
		}
		else if (msg.action === "chat") {
			request = {
				type: RoomRequestType.ChatRequest,
				client: this.id,
				...msg,
			};
		}
		else if (msg.action === "status") {
			request = {
				type: RoomRequestType.UpdateUser,
				client: this.id,
				info: {
					id: this.id,
					status: msg.status,
				},
			};
		}
		else if (msg.action === "set-role") {
			request = {
				type: RoomRequestType.PromoteRequest,
				client: this.id,
				targetClientId: msg.clientId,
				role: msg.role,
			};
		}
		else {
			log.warn(`Unknown client message: ${(msg as { action: string }).action}`);
			return;
		}

		try {
			await this.makeRoomRequest(request);
		}
		catch (e) {
			log.error(`Room request failed: ${e} ${e.stack}`);
		}
	}

	public OnPing(data: Buffer): void {
		log.debug(`sending pong`);
		this.Socket.pong();
	}

	public async JoinRoom(roomName: string): Promise<void> {
		log.debug(`client id=${this.id} joining ${roomName}`);

		const room = await roommanager.GetRoom(roomName);
		if (!room) {
			throw new RoomNotFoundException(roomName);
		}
		this.room = room.name;
		// full sync
		let state = roomStates.get(room.name);
		if (state === undefined) {
			log.warn("room state not present, grabbing");
			const stateText = await get(`room-sync:${room.name}`);
			state = JSON.parse(stateText);
			roomStates.set(room.name, state);
		}
		const syncMsg: ServerMessageSync = Object.assign({action: "sync"}, state) as ServerMessageSync;
		this.Socket.send(JSON.stringify(syncMsg));

		// actually join the room
		await subscribe(`room:${room.name}`);
		let clients = roomJoins.get(room.name);
		if (clients === undefined) {
			log.warn("room joins not present, creating");
			clients = [];
		}
		clients.push(this);
		roomJoins.set(room.name, clients);
		await room.processRequest({
			type: RoomRequestType.JoinRequest,
			client: this.id,
			info: this.clientInfo,
		});
	}

	public async makeRoomRequest(request: RoomRequest): Promise<void> {
		// FIXME: what if the room is not loaded on this node, but it's on a different node instead?
		// FIXME: only get room if it is loaded already.
		const room = await roommanager.GetRoom(this.room);
		if (!room) {
			throw new RoomNotFoundException(this.room);
		}
		await room.processRequest(request);
	}

	public sendObj(obj: any): void {
		try {
			this.Socket.send(JSON.stringify(obj));
		}
		catch (e) {
			log.error(`failed to send to client: ${e.message}`);
		}
	}
}

export function Setup(): void {
	log.debug("setting up client manager...");
	const server = wss as WebSocket.Server;
	server.on("connection", async (ws, req: Request & { session: Session }) => {
		if (!req.url.startsWith("/api/room/")) {
			log.error("Rejecting connection because the connection url was invalid");
			ws.close(OttWebsocketError.INVALID_CONNECTION_URL, "Invalid connection url");
			return;
		}
		await OnConnect(req.session, ws, req);
	});
}

/**
 * Called when a websocket connects.
 * @param session
 * @param socket
 */
async function OnConnect(session: Session, socket: WebSocket, req: Request) {
	const roomName = req.url.replace("/api/room/", "");
	log.debug(`connection received: ${roomName}`);
	const client = new Client(session as MySession, socket);
	connections.push(client);
	socket.on("ping", (data) => client.OnPing(data));
	socket.on("message", (data) => client.OnMessage(data as string));
	try {
		await client.JoinRoom(roomName);
	}
	catch (e) {
		if (e instanceof RoomNotFoundException) {
			log.info(`Failed to join room: ${e}`);
			socket.close(OttWebsocketError.ROOM_NOT_FOUND);
		}
		else {
			log.error(`Failed to join room: ${e.stack}`);
			socket.close(OttWebsocketError.UNKNOWN);
		}
	}
}

async function broadcast(roomName: string, text: string) {
	for (const client of roomJoins.get(roomName)) {
		try {
			client.Socket.send(text);
		}
		catch (e) {
			log.error(`failed to send to client: ${e.message}`);
		}
	}
}

async function onRedisMessage(channel: string, text: string) {
	// handles sync messages published by the rooms.
	log.silly(`pubsub message: ${channel}: ${text.substr(0, 200)}`);
	const msg = JSON.parse(text) as ServerMessage;
	if (channel.startsWith("room:")) {
		const roomName = channel.replace("room:", "");
		if (msg.action === "sync") {
			let state: RoomStateSyncable = roomStates.get(roomName);
			if (state === undefined) {
				const stateText = await get(`room-sync:${roomName}`);
				state = JSON.parse(stateText) as RoomStateSyncable;
			}
			const filtered = _.omit(msg, "action");
			if (state) {
				Object.assign(state, filtered);
			}
			else {
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				// @ts-ignore
				state = filtered;
			}
			roomStates.set(roomName, state);

			await broadcast(roomName, text);
		}
		else if (msg.action === "unload") {
			for (const client of roomJoins.get(roomName)) {
				client.Socket.close(OttWebsocketError.ROOM_UNLOADED, "The room was unloaded.");
			}
		}
		else if (msg.action === "chat") {
			await broadcast(roomName, text);
		}
		else if (msg.action === "event") {
			await broadcast(roomName, text);
		}
		else if (msg.action === "user") {
			for (const client of roomJoins.get(roomName)) {
				if (msg.user.id === client.id) {
					msg.user.isYou = true;
					client.sendObj(msg);
					break;
				}
			}
		}
		else {
			log.error(`Unknown server message: ${(msg as { action: string }).action}`);
		}
	}
	else if (channel === ANNOUNCEMENT_CHANNEL) {
		for (const client of connections) {
			try {
				client.Socket.send(text);
			}
			catch (e) {
				log.error(`failed to send to client: ${e.message}`);
			}
		}
	}
	else {
		log.error(`Unhandled message from redis channel: ${channel}`);
	}
}

redisSubscriber.on("message", onRedisMessage);

async function onUserModified(session: MySession) {
	log.debug(`User was modified: ${session}, telling rooms`);
	for (const client of connections) {
		if (client.Session.id === session.id) {
			client.Session = session;
			await client.makeRoomRequest({
				type: RoomRequestType.UpdateUser,
				client: client.id,
				info: client.clientInfo,
			});
		}
	}
}

function getClient(session: Session, roomName: string): Client {
	for (const client of connections) {
		if (client.Session.id === session.id && client.room === roomName) {
			return client;
		}
	}
	throw new ClientNotFoundInRoomException(roomName);
}

setInterval(() => {
	for (const client of connections) {
		client.Socket.ping();
	}
}, 10000);

export default {
	Setup,
	onUserModified,
	getClient,
};
