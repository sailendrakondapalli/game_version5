const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const MatchManager = require('./matchManager');
const config = require('./config');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "https://game-version4-31.onrender.com",
      "http://localhost:19006",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});


app.use(cors({
  origin: [
    "https://game-version4-31.onrender.com",
    "http://localhost:19006",
    "http://localhost:3000"
  ],
  credentials: true
}));

app.get('/', (req, res) => {
  res.send("🎮 Game server is running!");
});


app.use(express.json());

const matchManager = new MatchManager();
const gameLoops = new Map();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', matches: matchManager.matches.size });
});

app.get('/matches', (req, res) => {
  res.json({ matches: matchManager.getActiveMatches() });
});

io.on('connection', (socket) => {
  console.log(`🟢 Player connected: ${socket.id}`);

  // QUICK MATCH
  socket.on('quickMatch', (playerData) => {
    if (!playerData?.playerId || !playerData?.username) {
      socket.emit('matchError', { error: 'Invalid player data' });
      console.log('🔥 quickMatch received:', playerData);
      return;
    }

    console.log(`🎮 Quick match request from ${playerData.username}`);

    const result = matchManager.findQuickMatch(socket.id, playerData, 2);
    if (!result.success) {
      socket.emit('matchError', { error: result.error });
      return;
    }

    socket.join(result.match.code);
    io.to(result.match.code).emit('matchUpdate', result.match);

    const match = matchManager.getMatch(result.match.code);
    if (match.status === 'waiting' && match.players.size >= match.maxPlayers) {
      matchManager.startMatch(match.code);
      startGameLoop(match.code);
      io.to(match.code).emit('matchStart', { matchCode: match.code });
    }
  });

  socket.on('createMatch', ({ playerData, maxPlayers } = {}) => {
    if (!playerData?.playerId || !playerData?.username) {
      socket.emit('matchError', { error: 'Invalid player data' });
      return;
    }

    const result = matchManager.createPrivateMatch(socket.id, playerData, maxPlayers || 2);
    if (!result.success) {
      socket.emit('matchError', { error: result.error });
      return;
    }

    socket.join(result.code);
    socket.emit('matchCreated', { match: result.match, code: result.code });
  });

  socket.on('joinMatch', ({ matchCode, playerData } = {}) => {
    if (!matchCode || !playerData?.playerId || !playerData?.username) {
      socket.emit('matchError', { error: 'Invalid join data' });
      return;
    }

    const result = matchManager.joinMatch(matchCode, socket.id, playerData);
    if (!result.success) {
      socket.emit('matchError', { error: result.error });
      return;
    }

    socket.join(result.match.code);
    io.to(result.match.code).emit('matchUpdate', result.match);

    const match = matchManager.getMatch(result.match.code);
    if (match && match.players.size >= match.maxPlayers && match.status === 'waiting') {
      matchManager.startMatch(match.code);
      startGameLoop(match.code);

      const updated = {
        code: match.code,
        players: Array.from(match.players.values()),
        maxPlayers: match.maxPlayers,
        status: match.status,
      };

      io.to(match.code).emit('matchUpdate', updated);
      io.to(match.code).emit('matchStart', { matchCode: match.code });
      socket.emit('matchStart', { matchCode: match.code });
      return;
    }

    if (match && match.status === 'active') {
      startGameLoop(match.code);
      io.to(match.code).emit('matchStart', { matchCode: match.code });
    }
  });

  socket.on('playerMove', (data) => {
    const match = matchManager.getPlayerMatch(socket.id);
    if (!match?.gameManager) return;
    match.gameManager.updatePlayer(socket.id, data);
  });

  socket.on('playerShoot', (data) => {
    const match = matchManager.getPlayerMatch(socket.id);
    if (!match?.gameManager) return;
    const result = match.gameManager.handleShoot(socket.id, data);
    if (result) io.to(match.code).emit('playerShot', result);
  });

  socket.on('changeWeapon', (data) => {
    const match = matchManager.getPlayerMatch(socket.id);
    if (!match?.gameManager) return;
    match.gameManager.changeWeapon(socket.id, data.weapon);
  });

  socket.on('playerReload', () => {
    const match = matchManager.getPlayerMatch(socket.id);
    if (!match?.gameManager) return;
    match.gameManager.handleReload(socket.id);
  });

  // ⭐ ADDED — health kit pickup handler
  socket.on('pickupBloodKit', () => {
    const match = matchManager.getPlayerMatch(socket.id);
    if (!match?.gameManager) return;

    const result = match.gameManager.pickupHealthKit(socket.id);
    if (result) {
      io.to(match.code).emit('healthKitPicked', {
        playerId: socket.id,
        kitId: result.kitId,
        health: result.health,
      });
      io.to(match.code).emit('gameState', match.gameManager.getGameState());

    }
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Player disconnected: ${socket.id}`);
    const match = matchManager.leaveMatch(socket.id);
    if (match && match.players.size === 0) stopGameLoop(match.code);
  });
});

function startGameLoop(matchCode) {
  if (gameLoops.has(matchCode)) return;

  const match = matchManager.getMatch(matchCode);
  if (!match?.gameManager) return;

  let lastTime = Date.now();

  const loop = setInterval(() => {
    const now = Date.now();
    const deltaTime = now - lastTime;
    lastTime = now;

    const updateResult = match.gameManager.update(deltaTime);
    io.to(matchCode).emit('gameState', updateResult.gameState);

    if (updateResult.hits) {
      updateResult.hits.forEach(hit => {
        io.to(matchCode).emit('playerHit', { targetId: hit.targetId });
        if (hit.killed) {
          io.to(matchCode).emit('playerKilled', {
            killerId: hit.killerId,
            killerName: hit.killerName,
            victimId: hit.victimId,
            victimName: hit.victimName,
          });
        }
      });
    }

    if (match.gameManager.playersAlive === 1) {
      const winner = match.gameManager.getWinner();
      const results = matchManager.endMatch(matchCode, winner?.playerId);

      io.to(matchCode).emit('matchEnd', { winner, results });
      stopGameLoop(matchCode);
    }
  }, 1000 / config.TICK_RATE);

  gameLoops.set(matchCode, loop);
}

function stopGameLoop(matchCode) {
  const loop = gameLoops.get(matchCode);
  if (loop) {
    clearInterval(loop);
    gameLoops.delete(matchCode);
  }
}

const PORT = process.env.PORT || config.PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Game server running on port ${PORT}`);
  console.log(`⏱ Tick rate: ${config.TICK_RATE} Hz`);
});

