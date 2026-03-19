require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3002;
const JWT_SECRET = process.env.JWT_SECRET;

// Database
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors({ origin: ['https://analisedesligamentos.dsmetrics.online', 'https://dsmetrics.online', 'http://187.77.55.172:3080', 'http://localhost:3333'], credentials: true }));
app.use(express.json({ limit: '5mb' }));

// ——— AUTH MIDDLEWARE ———
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ——— SEED ADMIN ———
async function seedAdmin() {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['admin']);
  if (rows.length === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_DEFAULT_PASSWORD || 'admin123', 10);
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)', ['admin', hash, 'admin']);
    console.log('Admin user seeded');
  }
}

// ——— AUTH ROUTES ———
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
  const user = rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, username: user.username, role: user.role });
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Passwords required' });
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
  const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is wrong' });
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  res.json({ ok: true });
});

// Admin: reset any user's password
app.put('/api/users/:id/password', authMiddleware, adminOnly, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, parseInt(req.params.id)]);
  res.json({ ok: true });
});

// ——— USERS ———
app.get('/api/users', authMiddleware, adminOnly, async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY id');
  res.json(rows);
});

app.post('/api/users', authMiddleware, adminOnly, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)', [username, hash, role || 'viewer']);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    throw e;
  }
});

app.delete('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
});

// ——— DESLIGADOS ———
app.get('/api/desligados', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM desligados ORDER BY nome');
  res.json(rows);
});

app.post('/api/desligados', authMiddleware, adminOnly, async (req, res) => {
  const { nome, cargo, area } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO desligados (nome, cargo, area) VALUES ($1, $2, $3) RETURNING *',
      [nome, cargo || '', area || '']
    );
    res.json(rows[0]);
  } catch (e) {
    throw e;
  }
});

app.delete('/api/desligados/:id', authMiddleware, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM desligados WHERE id = $1', [parseInt(req.params.id)]);
  res.json({ ok: true });
});

// ——— RESPONSES ———
app.get('/api/responses', authMiddleware, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM responses ORDER BY id DESC');
  // Convert sinais_tipos and melhorias from JSON strings back to arrays
  const data = rows.map(r => ({
    ...r,
    sinais_tipos: r.sinais_tipos ? JSON.parse(r.sinais_tipos) : [],
    melhorias: r.melhorias ? JSON.parse(r.melhorias) : [],
    tempo_reacao: r.tempo_reacao || ''
  }));
  res.json(data);
});

app.post('/api/responses', async (req, res) => {
  const r = req.body;
  const { rows } = await pool.query(
    `INSERT INTO responses (
      gestor, funcionario, time_area, periodo, motivo, feedback, pip, expectativas,
      matriz_resp, matriz_entrega, matriz_cultura, matriz_comm,
      sinais, sinais_tipos, sinais_discussao,
      onboarding, buddy, onb_obs, ambiente, lideranca, perfil, selecao_cultural,
      one_on_one, autonomia, seg_psicologica, decisao, apoio_decisao,
      retros, impedimentos, participacao_ritos, capacidade, sm_atuacao,
      melhorias, obs, score, risk, tempo_reacao
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37
    ) RETURNING *`,
    [
      r.gestor, r.funcionario, r.time, r.periodo, r.motivo, r.feedback, r.pip, r.expectativas,
      r.matrizResp || 0, r.matrizEntrega || 0, r.matrizCultura || 0, r.matrizComm || 0,
      r.sinais, JSON.stringify(r.sinaisTipos || []), r.sinaisDiscussao,
      r.onboarding, r.buddy, r.onbObs, r.ambiente, r.lideranca || 3, r.perfil, r.selecaoCultural,
      r.oneOnOne, r.autonomia, r.segPsicologica, r.decisao, r.apoioDecisao,
      r.retros, r.impedimentos, r.participacaoRitos, r.capacidade, r.smAtuacao,
      JSON.stringify(r.melhorias || []), r.obs, r.score || 0, r.risk || 'baixo',
      r.tempoReacao || ''
    ]
  );
  res.json(rows[0]);
});

app.delete('/api/responses/:id', authMiddleware, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM responses WHERE id = $1', [parseInt(req.params.id)]);
  res.json({ ok: true });
});

app.delete('/api/responses', authMiddleware, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM responses');
  res.json({ ok: true });
});

// Delete all responses for a specific gestor
app.delete('/api/responses/by-gestor/:gestor', authMiddleware, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM responses WHERE gestor = $1', [req.params.gestor]);
  res.json({ ok: true });
});

// ——— IMPORT (bulk) ———
app.post('/api/responses/import', authMiddleware, adminOnly, async (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Array expected' });
  let count = 0;
  for (const r of items) {
    await pool.query(
      `INSERT INTO responses (
        gestor, funcionario, time_area, periodo, motivo, feedback, pip, expectativas,
        matriz_resp, matriz_entrega, matriz_cultura, matriz_comm,
        sinais, sinais_tipos, sinais_discussao,
        onboarding, buddy, onb_obs, ambiente, lideranca, perfil, selecao_cultural,
        one_on_one, autonomia, seg_psicologica, decisao, apoio_decisao,
        retros, impedimentos, participacao_ritos, capacidade, sm_atuacao,
        melhorias, obs, score, risk, tempo_reacao
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37
      )`,
      [
        r.gestor, r.funcionario, r.time || r.time_area, r.periodo, r.motivo, r.feedback, r.pip, r.expectativas,
        r.matrizResp || r.matriz_resp || 0, r.matrizEntrega || r.matriz_entrega || 0,
        r.matrizCultura || r.matriz_cultura || 0, r.matrizComm || r.matriz_comm || 0,
        r.sinais, JSON.stringify(r.sinaisTipos || r.sinais_tipos || []), r.sinaisDiscussao || r.sinais_discussao,
        r.onboarding, r.buddy, r.onbObs || r.onb_obs, r.ambiente, r.lideranca || 3, r.perfil,
        r.selecaoCultural || r.selecao_cultural,
        r.oneOnOne || r.one_on_one, r.autonomia, r.segPsicologica || r.seg_psicologica,
        r.decisao, r.apoioDecisao || r.apoio_decisao,
        r.retros, r.impedimentos, r.participacaoRitos || r.participacao_ritos,
        r.capacidade, r.smAtuacao || r.sm_atuacao,
        JSON.stringify(r.melhorias || []), r.obs, r.score || 0, r.risk || 'baixo',
        r.tempoReacao || r.tempo_reacao || ''
      ]
    );
    count++;
  }
  res.json({ imported: count });
});

// ——— HEALTH ———
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'analise-desligamentos' });
});

// ——— START ———
app.listen(PORT, async () => {
  console.log(`Analise Desligamentos API running on port ${PORT}`);
  await seedAdmin();
});
