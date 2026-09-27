const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// Game State
const players = {};
const bullets = [];
const MAP_SIZE = 100;

let nextBulletId = 0;

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  
  // Initialize new player
  players[socket.id] = {
    id: socket.id,
    x: (Math.random() - 0.5) * 40,
    z: (Math.random() - 0.5) * 40,
    rotation: Math.random() * Math.PI * 2,
    speed: 0,
    health: 100,
    color: Math.random() * 0xffffff,
    score: 0,
    dead: false,
    respawnTimer: 0
  };

  // Send current state to new player
  socket.emit('init', { id: socket.id, players });

  // Broadcast new player to others
  socket.broadcast.emit('playerJoined', players[socket.id]);

  socket.on('input', (input) => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    
    // input = { up, down, left, right, shoot }
    const ACCEL = 30;
    const MAX_SPEED = 20;
    const REVERSE_SPEED = 10;
    const TURN_SPEED = 3.0;
    const FRICTION = 0.95;
    
    // We'll trust the client for inputs but simulate on server tick. 
    // For simpler sync, we'll just store the input state.
    p.inputs = input;
  });

  socket.on('shoot', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    
    // Spawn bullet
    const bSpeed = 40;
    const bx = p.x + Math.sin(p.rotation) * 2;
    const bz = p.z + Math.cos(p.rotation) * 2;
    
    bullets.push({
      id: nextBulletId++,
      owner: socket.id,
      x: bx,
      z: bz,
      vx: Math.sin(p.rotation) * bSpeed,
      vz: Math.cos(p.rotation) * bSpeed,
      life: 2.0 // seconds
    });
    
    io.emit('playSound', 'shoot');
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// Server Tick Loop (60Hz)
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;

setInterval(() => {
  // Update Players
  for (const id in players) {
    const p = players[id];
    if (p.dead) {
      p.respawnTimer -= DT;
      if (p.respawnTimer <= 0) {
        p.dead = false;
        p.health = 100;
        p.x = (Math.random() - 0.5) * 40;
        p.z = (Math.random() - 0.5) * 40;
        p.speed = 0;
        io.emit('playerRespawned', p);
      }
      continue;
    }
    
    if (p.inputs) {
      if (p.inputs.up) {
        p.speed += 30 * DT;
        if (p.speed > 25) p.speed = 25;
      } else if (p.inputs.down) {
        p.speed -= 20 * DT;
        if (p.speed < -10) p.speed = -10;
      } else {
        p.speed *= 0.95; // friction
      }
      
      if (Math.abs(p.speed) > 0.5) {
        const turnMod = (p.speed / 25);
        if (p.inputs.left) p.rotation += 3.0 * turnMod * DT;
        if (p.inputs.right) p.rotation -= 3.0 * turnMod * DT;
      }
    } else {
      p.speed *= 0.95;
    }
    
    p.x += Math.sin(p.rotation) * p.speed * DT;
    p.z += Math.cos(p.rotation) * p.speed * DT;
    
    // Wall bounds
    const HMAP = MAP_SIZE / 2 - 2;
    if (p.x > HMAP) { p.x = HMAP; p.speed *= -0.5; }
    if (p.x < -HMAP) { p.x = -HMAP; p.speed *= -0.5; }
    if (p.z > HMAP) { p.z = HMAP; p.speed *= -0.5; }
    if (p.z < -HMAP) { p.z = -HMAP; p.speed *= -0.5; }
  }
  
  // Update Bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * DT;
    b.z += b.vz * DT;
    b.life -= DT;
    
    let hit = false;
    
    // Check player collisions
    for (const pid in players) {
      if (pid === b.owner) continue;
      const p = players[pid];
      if (p.dead) continue;
      
      const dx = p.x - b.x;
      const dz = p.z - b.z;
      const distSq = dx*dx + dz*dz;
      
      // Car hit radius ~2m
      if (distSq < 4.0) {
        p.health -= 20;
        hit = true;
        io.emit('playSound', 'hit');
        
        if (p.health <= 0) {
          p.dead = true;
          p.respawnTimer = 3.0;
          io.emit('playerDied', { id: pid, killer: b.owner });
          if (players[b.owner]) players[b.owner].score++;
        }
        break;
      }
    }
    
    const HMAP = MAP_SIZE / 2;
    if (b.x > HMAP || b.x < -HMAP || b.z > HMAP || b.z < -HMAP) hit = true;
    
    if (hit || b.life <= 0) {
      bullets.splice(i, 1);
    }
  }
  
  // Broadcast state
  io.emit('state', { players, bullets });
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
