
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const db = require("./config/db");

const app = express();

app.use(cors());
app.use(express.json());

// HOME ROUTE
app.get("/", (req, res) => {
    res.send("Bank Management System Backend is Running");
});

// REGISTER CUSTOMER
app.post("/api/register", async (req, res) => {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({
            message: "Name, email and password are required"
        });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        db.query(
            `INSERT INTO users (name, email, phone, password)
             VALUES (?, ?, ?, ?)`,
            [name, email, phone || null, hashedPassword],
            (err, result) => {
                if (err) {
                    if (err.code === "ER_DUP_ENTRY") {
                        return res.status(409).json({
                            message: "Email already registered"
                        });
                    }
                    console.error(err);
                    return res.status(500).json({
                        message: "Database error"
                    });
                }

                res.status(201).json({
                    message: "Registration successful",
                    userId: result.insertId
                });
            }
        );
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
});

// LOGIN CUSTOMER
app.post("/api/login", (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            message: "Email and password are required"
        });
    }

    db.query(
        "SELECT * FROM users WHERE email = ?",
        [email],
        async (err, results) => {
            if (err) {
                console.error(err);
                return res.status(500).json({
                    message: "Database error"
                });
            }

            if (results.length === 0) {
                return res.status(401).json({
                    message: "Invalid email or password"
                });
            }

            try {
                const user = results[0];
                const matches = await bcrypt.compare(
                    password,
                    user.password
                );

                if (!matches) {
                    return res.status(401).json({
                        message: "Invalid email or password"
                    });
                }

                res.json({
                    message: "Login successful",
                    user: {
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        phone: user.phone,
                        role: user.role
                    }
                });
            } catch (error) {
                console.error(error);
                res.status(500).json({ message: "Server error" });
            }
        }
    );
});

// CREATE BANK ACCOUNT
app.post("/api/accounts", (req, res) => {
    const { user_id, account_type } = req.body;

    if (!Number.isInteger(user_id) || user_id <= 0) {
        return res.status(400).json({
            message: "Valid user ID is required"
        });
    }

    const accountNumber =
        "ACC" + Date.now().toString().slice(-8);

    db.query(
        `INSERT INTO accounts
         (user_id, account_number, account_type, balance, status)
         VALUES (?, ?, ?, 0.00, 'ACTIVE')`,
        [user_id, accountNumber, account_type || "SAVINGS"],
        (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).json({
                    message: "Account creation failed"
                });
            }

            res.status(201).json({
                message: "Bank account created successfully",
                accountId: result.insertId,
                accountNumber
            });
        }
    );
});

// GET ACCOUNT DETAILS BY USER ID
app.get("/api/accounts/:userId", (req, res) => {
    db.query(
        `SELECT id, user_id, account_number, account_type,
                balance, status, created_at
         FROM accounts
         WHERE user_id = ?`,
        [req.params.userId],
        (err, results) => {
            if (err) {
                console.error(err);
                return res.status(500).json({
                    message: "Database error"
                });
            }

            res.json(results);
        }
    );
});

// HELPER: RECORD A TRANSACTION
// Uses your existing table columns:
// account_id, type, amount, description, created_at
function recordTransaction(connection, account, type, amount, description, callback) {
    connection.query(
        `INSERT INTO transactions
         (account_id, type, amount, description)
         VALUES (?, ?, ?, ?)`,
        [account.id, type, amount, description],
        callback
    );
}

// DEPOSIT MONEY
app.post("/api/deposit", (req, res) => {
    const { user_id, amount } = req.body;

    if (!Number.isInteger(user_id) || user_id <= 0 ||
        typeof amount !== "number" ||
        !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            message: "Valid user ID and positive amount are required"
        });
    }

    db.getConnection((err, connection) => {
        if (err) {
            return res.status(500).json({
                message: "Database connection failed"
            });
        }

        connection.beginTransaction(err => {
            if (err) {
                connection.release();
                return res.status(500).json({
                    message: "Deposit failed"
                });
            }

            connection.query(
                `SELECT id, user_id FROM accounts
                 WHERE user_id = ? AND status = 'ACTIVE'
                 LIMIT 1 FOR UPDATE`,
                [user_id],
                (err, accounts) => {
                    if (err || accounts.length === 0) {
                        return finish(err, "Active account not found", 404);
                    }

                    const account = accounts[0];

                    connection.query(
                        "UPDATE accounts SET balance = balance + ? WHERE id = ?",
                        [amount, account.id],
                        err => {
                            if (err) return finish(err, "Deposit failed", 500);

                            recordTransaction(
                                connection, account, "DEPOSIT",
                                amount, "Money deposited", err => {
                                    if (err) return finish(err, "Could not save transaction", 500);

                                    connection.commit(err => {
                                        if (err) return finish(err, "Deposit failed", 500);

                                        connection.release();
                                        res.json({
                                            message: "Deposit successful",
                                            depositedAmount: amount
                                        });
                                    });
                                }
                            );
                        }
                    );
                }
            );

            function finish(err, message, status = 500) {
                connection.rollback(() => {
                    connection.release();
                    if (err) console.error(err);
                    res.status(status).json({ message });
                });
            }
        });
    });
});

// WITHDRAW MONEY
app.post("/api/withdraw", (req, res) => {
    const { user_id, amount } = req.body;

    if (!Number.isInteger(user_id) || user_id <= 0 ||
        typeof amount !== "number" ||
        !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            message: "Valid user ID and positive amount are required"
        });
    }

    db.getConnection((err, connection) => {
        if (err) {
            return res.status(500).json({
                message: "Database connection failed"
            });
        }

        connection.beginTransaction(err => {
            if (err) {
                connection.release();
                return res.status(500).json({
                    message: "Withdrawal failed"
                });
            }

            connection.query(
                `SELECT id, user_id, balance FROM accounts
                 WHERE user_id = ? AND status = 'ACTIVE'
                 LIMIT 1 FOR UPDATE`,
                [user_id],
                (err, accounts) => {
                    if (err) return finish(err, "Database error", 500);

                    if (accounts.length === 0) {
                        return finish(null, "Active account not found", 404);
                    }

                    const account = accounts[0];

                    if (Number(account.balance) < amount) {
                        return finish(null, "Insufficient balance", 400);
                    }

                    connection.query(
                        "UPDATE accounts SET balance = balance - ? WHERE id = ?",
                        [amount, account.id],
                        err => {
                            if (err) return finish(err, "Withdrawal failed", 500);

                            recordTransaction(
                                connection, account, "WITHDRAWAL",
                                amount, "Money withdrawn", err => {
                                    if (err) return finish(err, "Could not save transaction", 500);

                                    connection.commit(err => {
                                        if (err) return finish(err, "Withdrawal failed", 500);

                                        connection.release();
                                        res.json({
                                            message: "Withdrawal successful",
                                            withdrawnAmount: amount
                                        });
                                    });
                                }
                            );
                        }
                    );
                }
            );

            function finish(err, message, status = 500) {
                connection.rollback(() => {
                    connection.release();
                    if (err) console.error(err);
                    res.status(status).json({ message });
                });
            }
        });
    });
});

// TRANSFER MONEY BETWEEN USERS
app.post("/api/transfer", (req, res) => {
    const { from_user_id, to_user_id, amount } = req.body;

    if (!Number.isInteger(from_user_id) || from_user_id <= 0 ||
        !Number.isInteger(to_user_id) || to_user_id <= 0 ||
        from_user_id === to_user_id ||
        typeof amount !== "number" ||
        !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            message: "Valid sender, receiver and positive amount are required"
        });
    }

    db.getConnection((err, connection) => {
        if (err) {
            return res.status(500).json({
                message: "Database connection failed"
            });
        }

        connection.beginTransaction(err => {
            if (err) {
                connection.release();
                return res.status(500).json({ message: "Transfer failed" });
            }

            connection.query(
                `SELECT id, user_id, balance FROM accounts
                 WHERE user_id IN (?, ?) AND status = 'ACTIVE'
                 ORDER BY id FOR UPDATE`,
                [from_user_id, to_user_id],
                (err, accounts) => {
                    if (err) return finish(err, "Database error", 500);

                    const sender = accounts.find(
                        a => a.user_id === from_user_id
                    );
                    const receiver = accounts.find(
                        a => a.user_id === to_user_id
                    );

                    if (!sender || !receiver) {
                        return finish(null, "Sender or receiver account not found", 404);
                    }

                    if (Number(sender.balance) < amount) {
                        return finish(null, "Insufficient balance", 400);
                    }

                    connection.query(
                        "UPDATE accounts SET balance = balance - ? WHERE id = ?",
                        [amount, sender.id],
                        err => {
                            if (err) return finish(err, "Transfer failed", 500);

                            connection.query(
                                "UPDATE accounts SET balance = balance + ? WHERE id = ?",
                                [amount, receiver.id],
                                err => {
                                    if (err) return finish(err, "Transfer failed", 500);

                                    recordTransaction(
                                        connection, sender, "TRANSFER",
                                        amount, `Transfer to user ${to_user_id}`,
                                        err => {
                                            if (err) return finish(err, "Could not save transaction", 500);

                                            recordTransaction(
                                                connection, receiver, "TRANSFER",
                                                amount, `Transfer from user ${from_user_id}`,
                                                err => {
                                                    if (err) return finish(err, "Could not save transaction", 500);

                                                    connection.commit(err => {
                                                        if (err) return finish(err, "Transfer failed", 500);

                                                        connection.release();
                                                        res.json({
                                                            message: "Transfer successful",
                                                            transferredAmount: amount
                                                        });
                                                    });
                                                }
                                            );
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );

            function finish(err, message, status = 500) {
                connection.rollback(() => {
                    connection.release();
                    if (err) console.error(err);
                    res.status(status).json({ message });
                });
            }
        });
    });
});

// GET TRANSACTION HISTORY BY USER ID
app.get("/api/transactions/:userId", (req, res) => {
    const userId = req.params.userId;

    db.query(
        `SELECT t.id, t.account_id, t.type, t.amount,
                t.description, t.created_at
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.user_id = ?
         ORDER BY t.created_at DESC`,
        [userId],
        (err, results) => {
            if (err) {
                console.error(err);
                return res.status(500).json({
                    message: "Database error"
                });
            }

            res.json(results);
        }
    );
});

// START SERVER
const PORT = 5000;

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
