require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;

app.use(cors());
app.use(express.json());

if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET in backend/.env");
  process.exit(1);
}

const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "library_management",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
});

const VALID_ROLES = ["Member", "Librarian", "Admin"];

function normalizeRole(role) {
  const value = String(role || "").toLowerCase();

  if (value === "member") return "Member";
  if (value === "librarian") return "Librarian";
  if (value === "admin") return "Admin";

  return null;
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  if (!token) {
    return res.status(401).json({ message: "Please log in first." });
  }

  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      message: "Your session is invalid or expired. Please log in again.",
    });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth) {
      return res.status(401).json({ message: "Please log in first." });
    }

    if (!allowedRoles.includes(req.auth.role)) {
      return res.status(403).json({
        message: "You do not have permission to perform this action.",
      });
    }

    next();
  };
}

async function createTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      membership_id VARCHAR(100) NOT NULL UNIQUE,
      role ENUM('Admin', 'Librarian', 'Member') NOT NULL DEFAULT 'Member',
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME NULL,
      last_logout_at DATETIME NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS books (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      author VARCHAR(255) NOT NULL,
      genre VARCHAR(100) DEFAULT '',
      isbn VARCHAR(50) DEFAULT '',
      quantity INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS loans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      book_id INT NOT NULL,
      quantity INT NOT NULL DEFAULT 1,
      loan_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      return_date DATETIME NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'Borrowed',
      INDEX idx_loans_user (user_id),
      INDEX idx_loans_book (book_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      book_id INT NOT NULL,
      user_id INT NOT NULL,
      transaction_type VARCHAR(30) NOT NULL,
      quantity INT NOT NULL DEFAULT 1,
      transaction_date DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add columns to older versions of the database if they are missing.
  await addColumnIfMissing(
    "users",
    "last_login_at",
    "DATETIME NULL"
  );

  await addColumnIfMissing(
    "users",
    "last_logout_at",
    "DATETIME NULL"
  );

  await addColumnIfMissing(
    "books",
    "genre",
    "VARCHAR(100) DEFAULT ''"
  );

  await addColumnIfMissing(
    "books",
    "isbn",
    "VARCHAR(50) DEFAULT ''"
  );

  await addColumnIfMissing(
    "loans",
    "quantity",
    "INT NOT NULL DEFAULT 1"
  );

  await addColumnIfMissing(
    "loans",
    "loan_date",
    "DATETIME DEFAULT CURRENT_TIMESTAMP"
  );

  await addColumnIfMissing(
    "loans",
    "return_date",
    "DATETIME NULL"
  );

  await addColumnIfMissing(
    "loans",
    "status",
    "VARCHAR(30) NOT NULL DEFAULT 'Borrowed'"
  );

  await addColumnIfMissing(
    "transactions",
    "transaction_type",
    "VARCHAR(30) NOT NULL DEFAULT 'Borrow'"
  );

  await addColumnIfMissing(
    "transactions",
    "quantity",
    "INT NOT NULL DEFAULT 1"
  );

  await addColumnIfMissing(
    "transactions",
    "transaction_date",
    "DATETIME DEFAULT CURRENT_TIMESTAMP"
  );
}

async function addColumnIfMissing(table, column, definition) {
  // Table and column names are internal constants, not user input.
  const [rows] = await db.query(
    `SHOW COLUMNS FROM \`${table}\` LIKE ?`,
    [column]
  );

  if (rows.length === 0) {
    await db.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`
    );
  }
}

async function recordTransaction(
  connection,
  bookId,
  userId,
  transactionType,
  quantity = 1
) {
  await connection.execute(
    `INSERT INTO transactions
      (book_id, user_id, transaction_type, quantity, transaction_date)
     VALUES (?, ?, ?, ?, NOW())`,
    [bookId, userId, transactionType, quantity]
  );
}

app.get(
  "/api/health",
  asyncRoute(async (req, res) => {
    await db.query("SELECT 1");
    res.json({ message: "BookBridge backend is running." });
  })
);

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

app.post(
  "/api/auth/register",
  asyncRoute(async (req, res) => {
    const name = String(req.body.name || "").trim();
    const membershipId = String(req.body.membership_id || "").trim();
    const password = String(req.body.password || "");
    const role = normalizeRole(req.body.role);

    if (!name || !membershipId || !password || !role) {
      return res.status(400).json({
        message: "Name, membership ID, password and valid role are required.",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        message: "Password must contain at least 8 characters.",
      });
    }

    const [existing] = await db.execute(
      "SELECT id FROM users WHERE membership_id = ?",
      [membershipId]
    );

    if (existing.length) {
      return res.status(409).json({
        message: "That membership ID is already registered.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [result] = await db.execute(
      `INSERT INTO users
        (name, membership_id, role, password_hash)
       VALUES (?, ?, ?, ?)`,
      [name, membershipId, role, passwordHash]
    );

    res.status(201).json({
      message: "Registration successful.",
      user: {
        id: result.insertId,
        name,
        membership_id: membershipId,
        role,
      },
    });
  })
);

app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    const membershipId = String(req.body.membership_id || "").trim();
    const password = String(req.body.password || "");

    if (!membershipId || !password) {
      return res.status(400).json({
        message: "Enter your membership ID and password.",
      });
    }

    const [rows] = await db.execute(
      `SELECT id, name, membership_id, role, password_hash
       FROM users
       WHERE membership_id = ?
       LIMIT 1`,
      [membershipId]
    );

    if (!rows.length) {
      return res.status(401).json({
        message: "Incorrect membership ID or password.",
      });
    }

    const foundUser = rows[0];
    const passwordMatches = await bcrypt.compare(
      password,
      foundUser.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        message: "Incorrect membership ID or password.",
      });
    }

    const role = normalizeRole(foundUser.role);

    if (!role) {
      return res.status(500).json({
        message: "This account has an invalid role. Contact the administrator.",
      });
    }

    await db.execute(
      "UPDATE users SET last_login_at = NOW() WHERE id = ?",
      [foundUser.id]
    );

    const user = {
      id: foundUser.id,
      name: foundUser.name,
      membership_id: foundUser.membership_id,
      role,
    };

    const token = jwt.sign(
      {
        id: user.id,
        membership_id: user.membership_id,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({
      message: "Login successful.",
      token,
      user,
    });
  })
);

app.post(
  "/api/auth/logout",
  requireAuth,
  asyncRoute(async (req, res) => {
    await db.execute(
      "UPDATE users SET last_logout_at = NOW() WHERE id = ?",
      [req.auth.id]
    );

    res.json({ message: "Logout recorded." });
  })
);

// --------------------------------------------------
// BOOK CATALOGUE
// All authenticated roles can view books.
// Only librarians can manage books.
// --------------------------------------------------

app.get(
  "/api/books",
  requireAuth,
  asyncRoute(async (req, res) => {
    const [books] = await db.execute(
      `SELECT id, title, author, genre, isbn, quantity, created_at
       FROM books
       ORDER BY title ASC`
    );

    res.json(books);
  })
);

app.get(
  "/api/books/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const [books] = await db.execute(
      `SELECT id, title, author, genre, isbn, quantity, created_at
       FROM books
       WHERE id = ?`,
      [req.params.id]
    );

    if (!books.length) {
      return res.status(404).json({ message: "Book not found." });
    }

    res.json(books[0]);
  })
);

app.post(
  "/api/books",
  requireAuth,
  requireRole("Librarian"),
  asyncRoute(async (req, res) => {
    const title = String(req.body.title || "").trim();
    const author = String(req.body.author || "").trim();
    const genre = String(req.body.genre || "").trim();
    const isbn = String(req.body.isbn || "").trim();
    const quantity = Number(req.body.quantity);

    if (
      !title ||
      !author ||
      !genre ||
      !isbn ||
      !Number.isInteger(quantity) ||
      quantity < 0
    ) {
      return res.status(400).json({
        message: "Provide a title, author, genre, ISBN and valid quantity.",
      });
    }

    const [existing] = await db.execute(
      "SELECT id FROM books WHERE isbn = ? AND isbn <> ''",
      [isbn]
    );

    if (existing.length) {
      return res.status(409).json({
        message: "A book with that ISBN already exists.",
      });
    }

    const [result] = await db.execute(
      `INSERT INTO books (title, author, genre, isbn, quantity)
       VALUES (?, ?, ?, ?, ?)`,
      [title, author, genre, isbn, quantity]
    );

    res.status(201).json({
      message: "Book added successfully.",
      id: result.insertId,
    });
  })
);

app.put(
  "/api/books/:id",
  requireAuth,
  requireRole("Librarian"),
  asyncRoute(async (req, res) => {
    const title = String(req.body.title || "").trim();
    const author = String(req.body.author || "").trim();
    const genre = String(req.body.genre || "").trim();
    const isbn = String(req.body.isbn || "").trim();
    const quantity = Number(req.body.quantity);
    const bookId = Number(req.params.id);

    if (
      !title ||
      !author ||
      !genre ||
      !isbn ||
      !Number.isInteger(quantity) ||
      quantity < 0
    ) {
      return res.status(400).json({
        message: "Provide a title, author, genre, ISBN and valid quantity.",
      });
    }

    const [existingBook] = await db.execute(
      "SELECT id, quantity FROM books WHERE id = ?",
      [bookId]
    );

    if (!existingBook.length) {
      return res.status(404).json({ message: "Book not found." });
    }

    const [duplicate] = await db.execute(
      "SELECT id FROM books WHERE isbn = ? AND id <> ?",
      [isbn, bookId]
    );

    if (duplicate.length) {
      return res.status(409).json({
        message: "Another book already uses that ISBN.",
      });
    }

    // Do not reduce the quantity below the number currently on loan.
    const [loanRows] = await db.execute(
      `SELECT COALESCE(SUM(quantity), 0) AS active_quantity
       FROM loans
       WHERE book_id = ?
         AND LOWER(status) <> 'returned'`,
      [bookId]
    );

    if (quantity < Number(loanRows[0].active_quantity)) {
      return res.status(400).json({
        message: "Quantity cannot be lower than the number of books currently borrowed.",
      });
    }

    await db.execute(
      `UPDATE books
       SET title = ?, author = ?, genre = ?, isbn = ?, quantity = ?
       WHERE id = ?`,
      [title, author, genre, isbn, quantity, bookId]
    );

    res.json({ message: "Book updated successfully." });
  })
);

app.delete(
  "/api/books/:id",
  requireAuth,
  requireRole("Librarian"),
  asyncRoute(async (req, res) => {
    const bookId = Number(req.params.id);

    const [books] = await db.execute(
      "SELECT id FROM books WHERE id = ?",
      [bookId]
    );

    if (!books.length) {
      return res.status(404).json({ message: "Book not found." });
    }

    const [activeLoans] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM loans
       WHERE book_id = ?
         AND LOWER(status) <> 'returned'`,
      [bookId]
    );

    if (Number(activeLoans[0].total) > 0) {
      return res.status(400).json({
        message: "This book cannot be removed while it is currently borrowed.",
      });
    }

    await db.execute("DELETE FROM books WHERE id = ?", [bookId]);

    res.json({ message: "Book removed successfully." });
  })
);

// --------------------------------------------------
// MEMBER LOANS
// Only Members can borrow and return books.
// The five-book limit is checked on the server.
// --------------------------------------------------

app.get(
  "/api/loans/my",
  requireAuth,
  requireRole("Member"),
  asyncRoute(async (req, res) => {
    const [loans] = await db.execute(
      `SELECT
         l.id,
         l.book_id,
         l.quantity,
         l.loan_date,
         l.return_date,
         l.status,
         b.title,
         b.author,
         b.genre,
         b.isbn
       FROM loans l
       JOIN books b ON b.id = l.book_id
       WHERE l.user_id = ?
       ORDER BY l.loan_date DESC, l.id DESC`,
      [req.auth.id]
    );

    res.json(loans);
  })
);

app.post(
  "/api/loans/borrow",
  requireAuth,
  requireRole("Member"),
  asyncRoute(async (req, res) => {
    const bookId = Number(req.body.book_id);

    if (!Number.isInteger(bookId) || bookId <= 0) {
      return res.status(400).json({ message: "Select a valid book." });
    }

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const [books] = await connection.execute(
        "SELECT id, title, quantity FROM books WHERE id = ? FOR UPDATE",
        [bookId]
      );

      if (!books.length) {
        await connection.rollback();
        return res.status(404).json({ message: "Book not found." });
      }

      if (Number(books[0].quantity) < 1) {
        await connection.rollback();
        return res.status(400).json({
          message: "No copies of this book are currently available.",
        });
      }

      const [activeRows] = await connection.execute(
        `SELECT COALESCE(SUM(quantity), 0) AS active_quantity
         FROM loans
         WHERE user_id = ?
           AND LOWER(status) <> 'returned'`,
        [req.auth.id]
      );

      if (Number(activeRows[0].active_quantity) >= 5) {
        await connection.rollback();
        return res.status(400).json({
          message: "You cannot borrow more than five books at a time.",
        });
      }

      await connection.execute(
        "UPDATE books SET quantity = quantity - 1 WHERE id = ?",
        [bookId]
      );

      const [loanResult] = await connection.execute(
        `INSERT INTO loans
          (user_id, book_id, quantity, loan_date, status)
         VALUES (?, ?, 1, NOW(), 'Borrowed')`,
        [req.auth.id, bookId]
      );

      await recordTransaction(
        connection,
        bookId,
        req.auth.id,
        "Borrow",
        1
      );

      await connection.commit();

      res.status(201).json({
        message: "Book borrowed successfully.",
        loan_id: loanResult.insertId,
      });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  })
);

app.post(
  "/api/loans/:id/return",
  requireAuth,
  requireRole("Member"),
  asyncRoute(async (req, res) => {
    const loanId = Number(req.params.id);
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const [loans] = await connection.execute(
        `SELECT id, book_id, quantity, status
         FROM loans
         WHERE id = ? AND user_id = ?
         FOR UPDATE`,
        [loanId, req.auth.id]
      );

      if (!loans.length) {
        await connection.rollback();
        return res.status(404).json({
          message: "Borrowing record not found for your account.",
        });
      }

      const loan = loans[0];

      if (String(loan.status).toLowerCase() === "returned") {
        await connection.rollback();
        return res.status(400).json({
          message: "This book has already been returned.",
        });
      }

      await connection.execute(
        `UPDATE loans
         SET status = 'Returned', return_date = NOW()
         WHERE id = ?`,
        [loanId]
      );

      await connection.execute(
        "UPDATE books SET quantity = quantity + ? WHERE id = ?",
        [Number(loan.quantity), loan.book_id]
      );

      await recordTransaction(
        connection,
        loan.book_id,
        req.auth.id,
        "Return",
        Number(loan.quantity)
      );

      await connection.commit();

      res.json({ message: "Book returned successfully." });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  })
);

// --------------------------------------------------
// ADMIN USER MANAGEMENT
// Only Admins can create or remove accounts or view
// the recorded login/logout activity.
// --------------------------------------------------

app.get(
  "/api/admin/users",
  requireAuth,
  requireRole("Admin"),
  asyncRoute(async (req, res) => {
    const [users] = await db.execute(
      `SELECT
         id,
         name,
         membership_id,
         role,
         created_at,
         last_login_at,
         last_logout_at
       FROM users
       ORDER BY created_at DESC`
    );

    res.json(users);
  })
);

app.post(
  "/api/admin/members",
  requireAuth,
  requireRole("Admin"),
  asyncRoute(async (req, res) => {
    const name = String(req.body.name || "").trim();
    const membershipId = String(req.body.membership_id || "").trim();
    const password = String(req.body.password || "");
    const role = normalizeRole(req.body.role);

    if (!name || !membershipId || !password || !role) {
      return res.status(400).json({
        message: "Name, membership ID, password and valid role are required.",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        message: "Password must contain at least 8 characters.",
      });
    }

    const [existing] = await db.execute(
      "SELECT id FROM users WHERE membership_id = ?",
      [membershipId]
    );

    if (existing.length) {
      return res.status(409).json({
        message: "That membership ID is already registered.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [result] = await db.execute(
      `INSERT INTO users
        (name, membership_id, role, password_hash)
       VALUES (?, ?, ?, ?)`,
      [name, membershipId, role, passwordHash]
    );

    res.status(201).json({
      message: "User created successfully.",
      user: {
        id: result.insertId,
        name,
        membership_id: membershipId,
        role,
      },
    });
  })
);

app.delete(
  "/api/admin/users/:id",
  requireAuth,
  requireRole("Admin"),
  asyncRoute(async (req, res) => {
    const targetId = Number(req.params.id);

    if (targetId === Number(req.auth.id)) {
      return res.status(400).json({
        message: "You cannot remove your own account.",
      });
    }

    const [targetUsers] = await db.execute(
      "SELECT id FROM users WHERE id = ?",
      [targetId]
    );

    if (!targetUsers.length) {
      return res.status(404).json({ message: "User not found." });
    }

    const [activeLoans] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM loans
       WHERE user_id = ?
         AND LOWER(status) <> 'returned'`,
      [targetId]
    );

    if (Number(activeLoans[0].total) > 0) {
      return res.status(400).json({
        message: "This user has books that must be returned before removal.",
      });
    }

    await db.execute("DELETE FROM users WHERE id = ?", [targetId]);

    res.json({ message: "User removed successfully." });
  })
);

// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ message: "API route not found." });
});

app.use((err, req, res, next) => {
  console.error("API error:", err);

  if (err.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      message: "That membership ID or ISBN is already in use.",
    });
  }

  res.status(500).json({
    message: "A server error occurred. Check the backend terminal.",
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

async function startServer() {
  try {
    await db.query("SELECT 1");
    await createTables();

    app.listen(PORT, () => {
      console.log(`BookBridge backend running at http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
    });
  } catch (err) {
    console.error("Could not start the backend:", err.message);
    process.exit(1);
  }
}

startServer();