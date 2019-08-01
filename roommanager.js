const WebSocket = require('ws');
const InfoExtract = require("./infoextract");
const { uniqueNamesGenerator } = require('unique-names-generator');

module.exports = function (server) {
	function syncRoom(room) {
		let syncMsg = {
			action: "sync",
			name: "test",
			currentSource: room.currentSource,
			queue: room.queue,
			isPlaying: room.isPlaying,
			playbackPosition: room.playbackPosition,
			playbackDuration: room.playbackDuration,
			users: []
		};


		for (let i = 0; i < room.clients.length; i++) {
			syncMsg.users = [];
			for (let u = 0; u < room.clients.length; u++) {
				syncMsg.users.push({
					name: room.clients[u].name,
					isYou: room.clients[i].socket == room.clients[u].socket
				});
			}

			let ws = room.clients[i].socket;
			if (ws.readyState != 1) {
				console.log("Remove inactive client:", i, room.clients[i].name);
				room.clients.splice(i, 1);
				i--;
				continue;
			}
			ws.send(JSON.stringify(syncMsg));
		}
	}

	function updateRoom(room) {
		if (room.currentSource == "" && room.queue.length > 0) {
			room.currentSource = room.queue.shift();
			InfoExtract.getVideoLengthYoutube(room.currentSource).then(seconds => {
				room.playbackDuration = seconds;
			}).catch(err => {
				console.error("Failed to get video length");
				console.error(err);
			});
		}
		else if (room.playbackPosition > room.playbackDuration) {
			room.currentSource = room.queue.length > 0 ? room.queue.shift() : "";
			room.playbackPosition = 0;
			if (room.currentSource != "") {
				InfoExtract.getVideoLengthYoutube(room.currentSource).then(seconds => {
					room.playbackDuration = seconds;
				}).catch(err => {
					console.error("Failed to get video length");
					console.error(err);
				});
			}
		}
		if (room.currentSource == "" && room.queue.length == 0 && room.isPlaying) {
			room.isPlaying = false;
			room.playbackPosition = 0;
			room.playbackDuration = 0;
		}
		syncRoom(room);
	}

	const wss = new WebSocket.Server({ server });

	let rooms = {
		test: {
			currentSource: "",
			queue: [],
			clients: [],
			isPlaying: false,
			playbackPosition: 0,
			playbackDuration: 0
		}
	};

	wss.on('connection', (ws, req) => {
		console.log("[ws] CONNECTION ESTABLISHED", ws.protocol, req.url, ws.readyState);

		if (!req.url.startsWith("/api/room/")) {
			console.error("[ws] Invalid connection url");
			ws.close(-1, "Invalid connection url");
		}
		let roomName = req.url.replace("/api/room/", "");

		rooms[roomName].clients.push({
			name: "client",
			socket: ws
		});

		ws.on('message', (message) => {
			console.log('[ws] received:', typeof(message), message);
			let msg = JSON.parse(message);
			if (msg.action == "play") {
				rooms["test"].isPlaying = true;
				syncRoom(rooms["test"]);
			}
			else if (msg.action == "pause") {
				rooms["test"].isPlaying = false;
				syncRoom(rooms["test"]);
			}
			else if (msg.action == "seek") {
				rooms["test"].playbackPosition = msg.position;
				syncRoom(rooms["test"]);
			}
			else if (msg.action == "skip") {
				rooms["test"].playbackPosition = rooms["test"].playbackDuration + 1;
				updateRoom(rooms["test"]);
			}
			else if (msg.action == "set-name") {
				if (!msg.name) {
					console.warn("name not supplied");
					return;
				}
				for (let i = 0; i < rooms["test"].clients.length; i++) {
					if (rooms["test"].clients[i].socket == ws) {
						rooms["test"].clients[i].name = msg.name;
						break;
					}
				}
				updateRoom(rooms["test"]);
			}
			else if (msg.action == "generate-name") {
				let generatedName = uniqueNamesGenerator();
				ws.send(JSON.stringify({
					action: "generatedName",
					name: generatedName
				}));

				for (let i = 0; i < rooms["test"].clients.length; i++) {
					if (rooms["test"].clients[i].socket == ws) {
						rooms["test"].clients[i].name = generatedName;
						break;
					}
				}
				updateRoom(rooms["test"]);
			}
			else {
				console.warn("[ws] UNKNOWN ACTION", msg.action);
			}
		});

		// sync room immediately
		syncRoom(rooms["test"]);
	});

	let roomTicker = setInterval(function() {
		for (let roomName in rooms) {
			let room = rooms[roomName];
			if (room.isPlaying) {
				room.playbackPosition += 1;
				updateRoom(room);
			}
		}
	}, 1000);

	return {
		rooms: rooms,
		syncRoom: syncRoom,
		updateRoom: updateRoom
	};
};