import express from 'express';
import cors from 'cors';
import TelegramBot from 'node-telegram-bot-api';
import crypto from 'crypto';

/*
 * TelegramChess server
 *
 * This server exposes a simple REST API for matchmaking, game state
 * management and rating persistence.  It is designed to be used with
 * the TelegramChess web‑app.  Players send HTTP requests to find
 * opponents, make moves and query game/rating state.  All state is
 * held in memory; if you plan to run this in production you should
 * back the maps with a database or at least persist them to disk.
 */

// ---------------------------------------------------------------------------
// Environment configuration
//
// BOT_TOKEN must be set to the token of your Telegram bot (obtained from
// @BotFather).  ALLOWED_ORIGINS controls which front‑end hosts may call
// this API.  PORT is optionally set by the hosting platform; if not
// provided, the server will listen on 8080.

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';
const port = Number(process.env.PORT) || 8080;

if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN is not set');
  process.exit(1);
}

// Start the Telegram bot in long‑polling mode.  Note that only one
// instance of the bot may poll updates at a time; ensure that the same
// token isn’t used elsewhere or you will see 409 errors.
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Attempt to delete any existing webhook so that polling can operate.
bot.deleteWebHook()
  .then(() => console.log('Webhook deleted (if any)'))
  .catch(err => console.error('Failed to delete webhook', err));

// Express application setup
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: (origin, cb) => {
      if (
        !origin ||
        ALLOWED_ORIGINS === '*' ||
        ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin)
      ) {
        return cb(null, true);
      }
      cb(new Error('Not allowed by CORS'));
    },
  }),
);

// ---------------------------------------------------------------------------
// In‑memory state
//
// queue: waiting players, keyed by userId.  When a player calls POST /match,
// they are added to this map.  As soon as two players are available, they
// are paired into a new game and removed from the queue.
const queue = new Map();

// scoreboard: maps userId to rating.  Default rating is 1500.  Ratings
// persist for as long as the process runs; you can periodically
// serialise this to disk or a database to maintain state across restarts.
const scoreboard = new Map();

// games: maps gameId to game state.  Each entry has the shape:
// {
//   id: string,
//   players: { w: { id, name }, b: { id, name } },
//   engine: SimpleChess instance,
//   turn: 'w' | 'b',
//   over: boolean,
//   result: null | { winnerId: string, loserId: string | null, reason: string }
// }
const games = new Map();

// ---------------------------------------------------------------------------
// SimpleChess implementation
//
// This is a lightweight chess engine adapted from the client‑side
// implementation.  It supports all basic piece moves, promotion and
// game end detection (checkmate and stalemate), but omits castling
// and en‑passant.  It maintains move history for undo but we
// primarily use its move validation and FEN generation on the server.

class SimpleChess {
  constructor() {
    this.reset();
  }

  reset() {
    this.board = [
      ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
      ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
      ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'],
    ];
    this.turnColor = 'w';
    this._history = [];
  }

  load(fen) {
    try {
      const parts = fen.trim().split(/\s+/);
      const placement = parts[0];
      const turn = parts[1] || 'w';
      const rows = placement.split('/');
      if (rows.length !== 8) return false;
      const board = [];
      for (let r = 0; r < 8; r++) {
        const row = [];
        let col = 0;
        for (const ch of rows[r]) {
          if (col > 7) break;
          if (ch >= '1' && ch <= '8') {
            const empty = parseInt(ch, 10);
            for (let i = 0; i < empty; i++) {
              row.push(null);
              col++;
            }
          } else {
            row.push(ch);
            col++;
          }
        }
        while (row.length < 8) row.push(null);
        board.push(row);
      }
      this.board = board;
      this.turnColor = turn === 'b' ? 'b' : 'w';
      this._history = [];
      return true;
    } catch (e) {
      return false;
    }
  }

  turn() {
    return this.turnColor;
  }

  _coordsToSquare(r, c) {
    return String.fromCharCode(97 + c) + String(8 - r);
  }

  _squareToCoords(square) {
    if (!square || square.length !== 2) return null;
    const file = square.charCodeAt(0) - 97;
    const rank = 8 - parseInt(square[1], 10);
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return [rank, file];
  }

  _inBounds(r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  }

  _generatePieceMoves(r, c) {
    const board = this.board;
    const piece = board[r][c];
    if (!piece) return [];
    const moves = [];
    const isWhite = piece === piece.toUpperCase();
    const color = isWhite ? 'w' : 'b';
    if (color !== this.turnColor) return [];
    const directions = {
      n: [
        [-2, -1],
        [-2, 1],
        [-1, -2],
        [-1, 2],
        [1, -2],
        [1, 2],
        [2, -1],
        [2, 1],
      ],
      b: [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ],
      r: [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ],
      q: [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ],
      k: [
        [-1, -1],
        [-1, 0],
        [-1, 1],
        [0, -1],
        [0, 1],
        [1, -1],
        [1, 0],
        [1, 1],
      ],
    };
    const fromSquare = this._coordsToSquare(r, c);
    const lower = piece.toLowerCase();
    // Pawn moves
    if (lower === 'p') {
      const dir = isWhite ? -1 : 1;
      const startRow = isWhite ? 6 : 1;
      const r1 = r + dir;
      if (this._inBounds(r1, c) && !board[r1][c]) {
        const toSq = this._coordsToSquare(r1, c);
        if (r1 === 0 || r1 === 7) {
          moves.push({ from: fromSquare, to: toSq, piece: piece.toLowerCase(), promotion: isWhite ? 'q' : 'q' });
        } else {
          moves.push({ from: fromSquare, to: toSq, piece: piece.toLowerCase() });
        }
        const r2 = r + 2 * dir;
        if (r === startRow && !board[r2][c]) {
          const toSq2 = this._coordsToSquare(r2, c);
          moves.push({ from: fromSquare, to: toSq2, piece: piece.toLowerCase() });
        }
      }
      for (const dc of [-1, 1]) {
        const rr = r + dir;
        const cc = c + dc;
        if (this._inBounds(rr, cc) && board[rr][cc]) {
          const target = board[rr][cc];
          const targetIsWhite = target === target.toUpperCase();
          if (targetIsWhite !== isWhite) {
            const toSq = this._coordsToSquare(rr, cc);
            if (rr === 0 || rr === 7) {
              moves.push({ from: fromSquare, to: toSq, piece: piece.toLowerCase(), captured: target.toLowerCase(), promotion: isWhite ? 'q' : 'q' });
            } else {
              moves.push({ from: fromSquare, to: toSq, piece: piece.toLowerCase(), captured: target.toLowerCase() });
            }
          }
        }
      }
      return moves;
    }
    // Knight moves
    if (lower === 'n') {
      for (const [dr, dc] of directions.n) {
        const rr = r + dr;
        const cc = c + dc;
        if (!this._inBounds(rr, cc)) continue;
        const target = board[rr][cc];
        if (target) {
          const targetIsWhite = target === target.toUpperCase();
          if (targetIsWhite !== isWhite) {
            moves.push({ from: fromSquare, to: this._coordsToSquare(rr, cc), piece: piece.toLowerCase(), captured: target.toLowerCase() });
          }
        } else {
          moves.push({ from: fromSquare, to: this._coordsToSquare(rr, cc), piece: piece.toLowerCase() });
        }
      }
      return moves;
    }
    // Sliding pieces (bishop, rook, queen)
    if (lower === 'b' || lower === 'r' || lower === 'q') {
      const dirs = directions[lower];
      for (const [dr, dc] of dirs) {
        let rr = r + dr;
        let cc = c + dc;
        while (this._inBounds(rr, cc)) {
          const target = board[rr][cc];
          if (target) {
            const targetIsWhite = target === target.toUpperCase();
            if (targetIsWhite !== isWhite) {
              moves.push({ from: fromSquare, to: this._coordsToSquare(rr, cc), piece: piece.toLowerCase(), captured: target.toLowerCase() });
            }
            break;
          } else {
            moves.push({ from: fromSquare, to: this._coordsToSquare(rr, cc), piece: piece.toLowerCase() });
          }
          rr += dr;
          cc += dc;
        }
      }
      return moves;
    }
    // King moves (no castling)
    if (lower === 'k') {
      for (const [dr, dc] of directions.k) {
        const rr = r + dr;
        const cc = c + dc;
        if (!this._inBounds(rr, cc)) continue;
        const target = board[rr][cc];
        if (target) {
          const targetIsWhite = target === target.toUpperCase();
          if (targetIsWhite !== isWhite) {
            moves.push({ from: fromSquare, to: this._coordsToSquare(rr, cc), piece: piece.toLowerCase(), captured: target.toLowerCase() });
          }
        } else {
          moves.push({ from: fromSquare, to: this._coordsToSquare(rr, cc), piece: piece.toLowerCase() });
        }
      }
      return moves;
    }
    return moves;
  }

  _isInCheck(color) {
    const isWhite = color === 'w';
    let kingRow = -1;
    let kingCol = -1;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = this.board[r][c];
        if (piece && piece.toLowerCase() === 'k') {
          if (isWhite === (piece === piece.toUpperCase())) {
            kingRow = r;
            kingCol = c;
            break;
          }
        }
      }
      if (kingRow !== -1) break;
    }
    if (kingRow === -1) return false;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = this.board[r][c];
        if (!piece) continue;
        const pieceIsWhite = piece === piece.toUpperCase();
        if (pieceIsWhite === isWhite) continue;
        const savedTurn = this.turnColor;
        this.turnColor = pieceIsWhite ? 'w' : 'b';
        const moves = this._generatePieceMoves(r, c);
        this.turnColor = savedTurn;
        for (const mv of moves) {
          const coords = this._squareToCoords(mv.to);
          if (coords && coords[0] === kingRow && coords[1] === kingCol) {
            return true;
          }
        }
      }
    }
    return false;
  }

  moves(opts = {}) {
    const verbose = opts.verbose || false;
    const square = opts.square || null;
    let moves = [];
    if (square) {
      const coords = this._squareToCoords(square);
      if (!coords) return [];
      moves = this._generatePieceMoves(coords[0], coords[1]);
    } else {
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const piece = this.board[r][c];
          if (!piece) continue;
          const isWhite = piece === piece.toUpperCase();
          const color = isWhite ? 'w' : 'b';
          if (color !== this.turnColor) continue;
          const pm = this._generatePieceMoves(r, c);
          moves.push(...pm);
        }
      }
    }
    const legalMoves = [];
    for (const mv of moves) {
      this._makeMove(mv);
      const inCheck = this._isInCheck(this.turnColor === 'w' ? 'b' : 'w');
      this.undo();
      if (!inCheck) {
        if (verbose) {
          legalMoves.push(Object.assign({}, mv));
        } else {
          legalMoves.push(mv.from + mv.to + (mv.promotion || ''));
        }
      }
    }
    return legalMoves;
  }

  _makeMove(mv) {
    const fromCoords = this._squareToCoords(mv.from);
    const toCoords = this._squareToCoords(mv.to);
    const r1 = fromCoords[0];
    const c1 = fromCoords[1];
    const r2 = toCoords[0];
    const c2 = toCoords[1];
    const piece = this.board[r1][c1];
    const captured = this.board[r2][c2];
    this._history.push({ mv, captured, turn: this.turnColor });
    this.board[r2][c2] = piece;
    this.board[r1][c1] = null;
    if (mv.promotion) {
      const promo = mv.promotion;
      this.board[r2][c2] = piece === piece.toUpperCase() ? promo.toUpperCase() : promo.toLowerCase();
    }
    this.turnColor = this.turnColor === 'w' ? 'b' : 'w';
  }

  move(mv) {
    if (typeof mv === 'string') {
      const from = mv.substring(0, 2);
      const to = mv.substring(2, 4);
      const promotion = mv.length > 4 ? mv.substring(4).toLowerCase() : undefined;
      mv = { from, to };
      if (promotion) mv.promotion = promotion;
    }
    const legalMoves = this.moves({ verbose: true });
    for (const lm of legalMoves) {
      if (lm.from === mv.from && lm.to === mv.to) {
        if (mv.promotion && mv.promotion !== lm.promotion) continue;
        this._makeMove(lm);
        return lm;
      }
    }
    return null;
  }

  undo() {
    const entry = this._history.pop();
    if (!entry) return null;
    const mv = entry.mv;
    const fromCoords = this._squareToCoords(mv.from);
    const toCoords = this._squareToCoords(mv.to);
    const r1 = fromCoords[0];
    const c1 = fromCoords[1];
    const r2 = toCoords[0];
    const c2 = toCoords[1];
    const piece = this.board[r2][c2];
    let restorePiece = piece;
    if (mv.promotion) {
      restorePiece = piece === piece.toUpperCase() ? 'P' : 'p';
    }
    this.board[r1][c1] = restorePiece;
    this.board[r2][c2] = entry.captured || null;
    this.turnColor = entry.turn;
    return mv;
  }

  _currentInCheck() {
    return this._isInCheck(this.turnColor);
  }

  in_check() {
    return this._currentInCheck();
  }

  in_checkmate() {
    if (!this._currentInCheck()) return false;
    return this.moves().length === 0;
  }

  in_stalemate() {
    if (this._currentInCheck()) return false;
    return this.moves().length === 0;
  }

  in_draw() {
    return this.in_stalemate();
  }

  game_over() {
    return this.in_checkmate() || this.in_stalemate();
  }

  boardState() {
    const out = [];
    for (const row of this.board) {
      const outRow = [];
      for (const cell of row) {
        if (!cell) {
          outRow.push(null);
        } else {
          outRow.push({ type: cell.toLowerCase(), color: cell === cell.toUpperCase() ? 'w' : 'b' });
        }
      }
      out.push(outRow);
    }
    return out;
  }

  history(opts = {}) {
    const verbose = opts && opts.verbose;
    if (verbose) {
      return this._history.map(entry => Object.assign({}, entry.mv));
    }
    return this._history.map(entry => entry.mv.from + entry.mv.to + (entry.mv.promotion || ''));
  }

  get(square) {
    const coords = this._squareToCoords(square);
    if (!coords) return null;
    const piece = this.board[coords[0]][coords[1]];
    if (!piece) return null;
    return { type: piece.toLowerCase(), color: piece === piece.toUpperCase() ? 'w' : 'b' };
  }

  fen() {
    let fen = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let c = 0; c < 8; c++) {
        const cell = this.board[r][c];
        if (!cell) {
          empty++;
        } else {
          if (empty > 0) {
            fen += empty;
            empty = 0;
          }
          fen += cell;
        }
      }
      if (empty > 0) fen += empty;
      if (r < 7) fen += '/';
    }
    fen += ' ' + (this.turnColor === 'w' ? 'w' : 'b') + ' - - 0 1';
    return fen;
  }
}

// ---------------------------------------------------------------------------
// Rating helpers
//
function getRating(userId) {
  return scoreboard.get(userId) ?? 1500;
}

function updateRatings(winnerId, loserId) {
  const winnerRating = getRating(winnerId);
  const loserRating = getRating(loserId);
  const newWinnerRating = winnerRating + 5;
  // If the loser’s rating is less than the winner’s, the loser loses 4 points;
  // otherwise they lose 3 points.  Ratings never drop below 1.
  const penalty = loserRating < winnerRating ? 4 : 3;
  const newLoserRating = Math.max(1, loserRating - penalty);
  scoreboard.set(winnerId, newWinnerRating);
  scoreboard.set(loserId, newLoserRating);
}

// ---------------------------------------------------------------------------
// Matchmaking and game management

/**
 * Helper to find the closest rated opponent in the queue for the given player.
 * Returns the opponent entry or null if none found.  Opponents are selected
 * based on minimal absolute rating difference.
 */
function findBestOpponent(player) {
  let bestId = null;
  let bestDiff = Infinity;
  for (const [id, u] of queue) {
    if (id === player.id) continue;
    const diff = Math.abs((u.rating ?? 1500) - (player.rating ?? 1500));
    if (diff < bestDiff) {
      bestDiff = diff;
      bestId = id;
    }
  }
  return bestId ? queue.get(bestId) : null;
}

function createGame(playerA, playerB) {
  // Assign colours randomly
  const whiteFirst = Math.random() < 0.5;
  const white = whiteFirst ? playerA : playerB;
  const black = whiteFirst ? playerB : playerA;
  const gameId = crypto.randomUUID();
  const engine = new SimpleChess();
  games.set(gameId, {
    id: gameId,
    players: { w: { id: white.id, name: white.name }, b: { id: black.id, name: black.name } },
    engine,
    turn: 'w',
    over: false,
    result: null,
  });
  return { gameId, whiteId: white.id, blackId: black.id, fen: engine.fen() };
}

// POST /match
// Body: { id: string, name: string, rating: number, initData?: string }
// Response: { matched: false } if no opponent yet, or
// { matched: true, gameId, color, opponent: { id, name, rating }, fen }
app.post('/match', (req, res) => {
  const { id, name, rating } = req.body || {};
  if (!id || !name) {
    res.status(400).json({ error: 'id and name are required' });
    return;
  }
  // Ensure rating is a number
  const parsedRating = Number(rating) || getRating(id);
  // Save current rating to scoreboard if not present
  if (!scoreboard.has(id)) scoreboard.set(id, parsedRating);
  const me = { id: String(id), name: String(name), rating: parsedRating };
  // See if this user is already waiting; if so, update their timestamp
  queue.set(me.id, { ...me, ts: Date.now() });
  // Attempt to find the best opponent
  const opp = findBestOpponent(me);
  if (opp) {
    queue.delete(me.id);
    queue.delete(opp.id);
    const gameInfo = createGame(me, opp);
    // Determine my colour and opponent info
    const myColor = gameInfo.whiteId === me.id ? 'w' : 'b';
    const opponent = { id: opp.id, name: opp.name, rating: getRating(opp.id) };
    res.json({ matched: true, gameId: gameInfo.gameId, color: myColor, opponent, fen: gameInfo.fen });
    return;
  }
  // No opponent yet; return matched:false
  res.json({ matched: false });
});

// GET /match/:id
// Returns match status for a player.  If the player has been paired
// into a game, returns the same data structure as POST /match when a
// match is found; otherwise returns { matched: false }.  This
// endpoint allows clients to poll for match results if the POST call
// initially returned matched: false.
app.get('/match/:id', (req, res) => {
  const id = String(req.params.id);
  // Search through active games to see if this user is part of one
  for (const [gid, game] of games) {
    if (game.players.w.id === id || game.players.b.id === id) {
      const myColor = game.players.w.id === id ? 'w' : 'b';
      const opponent = myColor === 'w' ? game.players.b : game.players.w;
      return res.json({
        matched: true,
        gameId: gid,
        color: myColor,
        opponent: { id: opponent.id, name: opponent.name, rating: getRating(opponent.id) },
        fen: game.engine.fen(),
      });
    }
  }
  // If not paired yet, indicate no match
  res.json({ matched: false });
});

// GET /game/:id
// Returns current game state: fen, turn color, whether game is over and
// result info, plus players and their ratings.  If the game does not
// exist, returns 404.
app.get('/game/:id', (req, res) => {
  const gameId = req.params.id;
  const game = games.get(gameId);
  if (!game) {
    res.status(404).json({ error: 'game not found' });
    return;
  }
  const { engine, players, turn, over, result } = game;
  const state = {
    fen: engine.fen(),
    turn,
    over,
    result,
    players: {
      w: { id: players.w.id, name: players.w.name, rating: getRating(players.w.id) },
      b: { id: players.b.id, name: players.b.name, rating: getRating(players.b.id) },
    },
  };
  res.json(state);
});

// POST /game/:id/move
// Body: { playerId: string, from: string, to: string, promotion?: string }
// Executes a move if it is legal and it is the player's turn.  Returns the
// updated game state (like GET /game) or an error message.
app.post('/game/:id/move', (req, res) => {
  const gameId = req.params.id;
  const { playerId, from, to, promotion } = req.body || {};
  const game = games.get(gameId);
  if (!game) {
    res.status(404).json({ error: 'game not found' });
    return;
  }
  if (!playerId || !from || !to) {
    res.status(400).json({ error: 'playerId, from and to are required' });
    return;
  }
  const { engine, players, turn, over } = game;
  if (over) {
    res.status(400).json({ error: 'game already over' });
    return;
  }
  // Check if it's the player's turn
  const myColor = players.w.id === playerId ? 'w' : players.b.id === playerId ? 'b' : null;
  if (!myColor) {
    res.status(403).json({ error: 'you are not a player in this game' });
    return;
  }
  if (myColor !== engine.turn()) {
    res.status(400).json({ error: 'not your turn' });
    return;
  }
  // Attempt to make the move
  const mv = { from: from.toLowerCase(), to: to.toLowerCase() };
  if (promotion) mv.promotion = promotion.toLowerCase();
  const legal = engine.move(mv);
  if (!legal) {
    res.status(400).json({ error: 'illegal move' });
    return;
  }
  // Update turn
  game.turn = engine.turn();
  // Check for end of game
  let result = null;
  if (engine.in_checkmate()) {
    // Current turn is the side to move after the move; so winner is opposite
    const winnerColor = engine.turn() === 'w' ? 'b' : 'w';
    const loserColor = engine.turn();
    const winnerId = winnerColor === 'w' ? game.players.w.id : game.players.b.id;
    const loserId = loserColor === 'w' ? game.players.w.id : game.players.b.id;
    updateRatings(winnerId, loserId);
    result = { winnerId, loserId, reason: 'checkmate' };
    game.over = true;
    game.result = result;
  } else if (engine.in_stalemate()) {
    // Stalemate: no rating change
    result = { winnerId: null, loserId: null, reason: 'stalemate' };
    game.over = true;
    game.result = result;
  }
  // Prepare response state
  const state = {
    fen: engine.fen(),
    turn: engine.turn(),
    over: game.over,
    result: game.result,
    players: {
      w: { id: game.players.w.id, name: game.players.w.name, rating: getRating(game.players.w.id) },
      b: { id: game.players.b.id, name: game.players.b.name, rating: getRating(game.players.b.id) },
    },
  };
  res.json(state);
});

// GET /score/:id
// Returns the current rating of the specified user.
app.get('/score/:id', (req, res) => {
  const id = String(req.params.id);
  const rating = getRating(id);
  res.json({ id, rating });
});

// Start server
app.listen(port, () => {
  console.log(`Server is running on :${port}`);
});