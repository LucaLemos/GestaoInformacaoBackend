require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// Configuração de segurança
app.use(helmet());

// Configuração CORS completa
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  next();
});

app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 1000 // limite de requisições
});
app.use(limiter);

// Conexão com PostgreSQL
/*
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'arborizacao_urbana',
  password: process.env.DB_PASSWORD || 'senha1234',
  port: process.env.DB_PORT || 5432,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Obrigatório para Neon
  }
});


// Testar conexão com o banco
pool.connect((err, client, release) => {
  if (err) {
    console.error('Erro ao conectar ao banco:', err.stack);
    process.exit(1);
  }
  console.log('Conexão com PostgreSQL estabelecida');
  release();
});

// Middleware de log para debug
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Endpoint de registro
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ 
      success: false,
      message: 'Username e senha são obrigatórios' 
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verifica se o usuário já existe
    const userCheck = await client.query(
      'SELECT id FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (userCheck.rowCount > 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Username já está em uso' 
      });
    }

    // Cria o usuário
    const userResult = await client.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username',
      [username.toLowerCase(), password]
    );

    await client.query('COMMIT');
    
    res.status(201).json({ 
      success: true,
      user: userResult.rows[0] 
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Registration error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Erro ao registrar usuário' 
    });
  } finally {
    client.release();
  }
});

// Endpoint de login
app.post('/api/auth/login', async (req, res) => {
  console.log('aqui')
  const { username, password } = req.body;
  console.log(username)
  console.log(password)

  // Validação básica
  if (!username || !password) {
    return res.status(400).json({ 
      success: false,
      message: 'Username e senha são obrigatórios' 
    });
  }

  try {
    // 1. Primeiro verifica se o usuário existe
    const userQuery = await pool.query(
      'SELECT id, username, password FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    // Se não encontrou usuário
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Usuário não encontrado' 
      });
    }

    const user = userQuery.rows[0];

    // 2. Verifica a senha (considerando que está sem hash por enquanto)
    if (password !== user.password) {
      return res.status(401).json({ 
        success: false,
        message: 'Senha incorreta' 
      });
    }

    // 3. Se chegou aqui, login é válido
    return res.json({ 
      success: true,
      message: 'Login bem-sucedido',
      user: {
        id: user.id,
        username: user.username
      },
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Erro interno ao processar login' 
    });
  }
});

app.get('/api/plantas', async (req, res) => {
  const { search } = req.query;
  
  try {
    let query = `
      SELECT 
        id,
        nome_cientifico, 
        nome_popular,
        detalhes,
        data_plantio,
        fonte,
        usuario_id,
        latitude,
        longitude,
        created_at
      FROM plantas
      WHERE 1=1
    `;

    const params = [];
    
    if (search) {
      query += ` AND (nome_popular ILIKE $1 OR nome_cientifico ILIKE $1)`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY nome_cientifico`;

    const { rows } = await pool.query(query, params);
    
    // Formata a resposta para manter compatibilidade
    const formattedRows = rows.map(row => ({
      ...row,
      tipo: 'planta',
      count: 1 // Para manter a estrutura esperada pelo frontend
    }));
    
    res.json(formattedRows);
  } catch (err) {
    console.error('Erro ao buscar plantas:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/plants', async (req, res) => {
  const {
    nome_cientifico,
    nome_popular,
    detalhes,
    data_plantio,
    fonte,
    usuario_id,
    latitude,
    longitude
  } = req.body;

  // Validação - pelo menos um nome deve estar preenchido
  if (!nome_cientifico && !nome_popular) {
    return res.status(400).json({ 
      success: false,
      message: 'Pelo menos o nome científico ou popular deve ser fornecido' 
    });
  }

  // Validação - coordenadas são obrigatórias
  if (!latitude || !longitude) {
    return res.status(400).json({ 
      success: false,
      message: 'Coordenadas geográficas são obrigatórias' 
    });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO plantas (
        nome_cientifico, 
        nome_popular, 
        detalhes, 
        data_plantio, 
        fonte, 
        usuario_id, 
        latitude, 
        longitude
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
      RETURNING *`,
      [
        nome_cientifico || null,
        nome_popular || null,
        detalhes || null,
        data_plantio || null,
        fonte || null,
        usuario_id || null,
        latitude,
        longitude
      ]
    );
    
    res.status(201).json({ 
      success: true,
      plant: rows[0],
      message: 'Planta cadastrada com sucesso'
    });
  } catch (err) {
    console.error('Database error:', {
      message: err.message,
      code: err.code,
      detail: err.detail,
      constraint: err.constraint
    });
    
    let errorMessage = 'Erro ao cadastrar planta';

    res.status(500).json({ 
      success: false,
      message: errorMessage,
      error: err.message
    });
  }
});

// GET - Listar comentários de uma planta
app.get('/api/plants/:plantId/comments', async (req, res) => {
  const { plantId } = req.params;
  
  try {
    const { rows } = await pool.query(`
      SELECT pc.*, u.username as author
      FROM plant_comments pc
      JOIN users u ON pc.user_id = u.id
      WHERE pc.plant_id = $1
      ORDER BY pc.created_at DESC
    `, [plantId]);
    
    res.json(rows);
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// POST - Adicionar comentário
app.post('/api/plants/:plantId/comments', async (req, res) => {
  const { plantId } = req.params;
  const { userId, text } = req.body;
  
  if (!userId || !text) {
    return res.status(400).json({ error: 'userId and text are required' });
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO plant_comments (plant_id, user_id, comment_text)
      VALUES ($1, $2, $3)
      RETURNING *, (SELECT username FROM users WHERE id = $2) as author
    `, [plantId, userId, text]);
    
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error adding comment:', {
      message: err.message,
      stack: err.stack,
      code: err.code,
      detail: err.detail,
      constraint: err.constraint
    });
    res.status(500).json({ 
      error: 'Failed to add comment',
      details: err.message 
    });
  }
});

// Endpoint de espécies
app.get('/api/especies', async (req, res) => {
  const { search, familia, rpa } = req.query;
  
  try {
    let query = `
      SELECT 
        'arvore_tombada' AS tipo,
        id,
        nome_cientifico, 
        nome_popular,
        familia,
        latitude,
        longitude,
        NULL AS altura,
        NULL AS dap,
        rpa
      FROM arvores_tombadas
      WHERE 1=1
    `;

    const params = [];
    const conditions = [];

    if (search) {
      conditions.push(`(nome_popular ILIKE $${params.length + 1} OR nome_cientifico ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }
    if (familia) {
      conditions.push(`familia = $${params.length + 1}`);
      params.push(familia);
    }
    if (rpa) {
      conditions.push(`rpa = $${params.length + 1}`);
      params.push(rpa);
    }

    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
    }

    query += `
      UNION ALL
      SELECT 
        'censo' AS tipo,
        id,
        nome_cientifico,
        nome_popular,
        NULL AS familia,
        y_wgs84 AS latitude,
        x_wgs84 AS longitude,
        altura,
        dap,
        rpa
      FROM censo_arboreo
      WHERE nome_cientifico IS NOT NULL
    `;

    conditions.length = 0;

    if (search) {
      conditions.push(`(nome_popular ILIKE $${params.length + 1} OR nome_cientifico ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }
    if (rpa) {
      conditions.push(`rpa = $${params.length + 1}`);
      params.push(rpa);
    }

    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
    }

    query += ` ORDER BY nome_popular`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar espécies:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Endpoint de filtros
app.get('/api/filtros', async (req, res) => {
  try {
    const [familias, rpas] = await Promise.all([
      pool.query('SELECT DISTINCT familia FROM arvores_tombadas WHERE familia IS NOT NULL'),
      pool.query('SELECT DISTINCT rpa FROM arvores_tombadas WHERE rpa IS NOT NULL UNION SELECT DISTINCT rpa FROM censo_arboreo WHERE rpa IS NOT NULL')
    ]);
    
    res.json({
      familias: familias.rows.map(f => f.familia),
      rpas: rpas.rows.map(r => r.rpa).sort((a, b) => a - b)
    });
  } catch (err) {
    console.error('Erro ao buscar filtros:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Forum Endpoints

// Get all rooms
app.get('/api/rooms', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*, COUNT(m.id) as message_count
      FROM rooms r
      LEFT JOIN messages m ON r.id = m.room_id
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching rooms:', err);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// Create a new room
app.post('/api/rooms', async (req, res) => {
  const { name, description, creator_id } = req.body;

  if (!name || !creator_id) {
    return res.status(400).json({ error: 'Name and creator ID are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Create room
    const roomResult = await client.query(
      'INSERT INTO rooms (name, description, creator_id) VALUES ($1, $2, $3) RETURNING *',
      [name, description, creator_id]
    );
    
    // 2. Add creator to members
    await client.query(
      'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)',
      [roomResult.rows[0].id, creator_id]
    );
    
    await client.query('COMMIT');
    res.status(201).json(roomResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Full error:', {
      message: err.message,
      stack: err.stack,
      code: err.code, // PostgreSQL error code
      detail: err.detail,
      constraint: err.constraint
    });
    res.status(500).json({ 
      error: 'Database operation failed',
      details: err.message,
      code: err.code
    });
  } finally {
    client.release();
  }
});

// Get messages for a room
app.get('/api/rooms/:roomId/messages', async (req, res) => {
  const { roomId } = req.params;
  const { limit = 50 } = req.query;

  try {
    const { rows } = await pool.query(
      `SELECT * FROM messages 
       WHERE room_id = $1 
       ORDER BY timestamp DESC
       LIMIT $2`,
      [roomId, limit]
    );
    res.json(rows.reverse()); // Reverse to show oldest first at top
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Send a message to a room
app.post('/api/rooms/:roomId/messages', async (req, res) => {
  const { roomId } = req.params;
  const { sender_id, content } = req.body;

  if (!sender_id || !content) {
    return res.status(400).json({ error: 'Sender ID and content are required' });
  }

  try {
    // Verify user is a member of the room
    const memberCheck = await pool.query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, sender_id]
    );

    if (memberCheck.rowCount === 0) {
      return res.status(403).json({ error: 'User is not a member of this room' });
    }

    const { rows } = await pool.query(
      'INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *',
      [roomId, sender_id, content]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Join a room
app.post('/api/rooms/:roomId/join', async (req, res) => {
  const { roomId } = req.params;
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    // Check if user is already a member
    const existingMember = await pool.query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, user_id]
    );

    if (existingMember.rowCount > 0) {
      return res.status(200).json({ message: 'User is already a member' });
    }

    await pool.query(
      'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)',
      [roomId, user_id]
    );
    res.status(200).json({ message: 'Successfully joined room' });
  } catch (err) {
    console.error('Error joining room:', err);
    res.status(500).json({ error: 'Failed to join room' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Tratamento de erros
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// Encerramento adequado
process.on('SIGTERM', () => {
  pool.end();
  process.exit(0);
});