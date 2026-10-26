import { useEffect, useState } from "react";
import "./App.css";

const API = "http://localhost:5000/api";
const TOKEN_KEY = "bookbridge_token";
const USER_KEY = "bookbridge_user";

function normalizeRole(role) {
  const value = String(role || "Member").toLowerCase();
  if (value === "admin") return "Admin";
  if (value === "librarian") return "Librarian";
  return "Member";
}

async function apiRequest(path, options = {}, token = "") {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || `Request failed: ${response.status}`);
  }

  return data;
}

function App() {
  const [page, setPage] = useState("home");
  const [registerRole, setRegisterRole] = useState("Member");

  const [token, setToken] = useState(
    () => localStorage.getItem(TOKEN_KEY) || ""
  );

  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  });

  const [books, setBooks] = useState([]);
  const [loans, setLoans] = useState([]);
  const [users, setUsers] = useState([]);
  const [selectedBook, setSelectedBook] = useState(null);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [loginForm, setLoginForm] = useState({
    membership_id: "",
    password: "",
  });

  const [registerForm, setRegisterForm] = useState({
    name: "",
    membership_id: "",
    password: "",
  });

  const emptyBookForm = {
    title: "",
    author: "",
    genre: "",
    isbn: "",
    quantity: 1,
  };

  const [bookForm, setBookForm] = useState(emptyBookForm);
  const [editingBookId, setEditingBookId] = useState(null);

  const [newUser, setNewUser] = useState({
    name: "",
    membership_id: "",
    password: "",
    role: "Member",
  });

  const authenticated = Boolean(token && user);
  const role = normalizeRole(user?.role);

  function clearAlerts() {
    setMessage("");
    setError("");
  }

  function showError(err) {
    setError(err?.message || "Something went wrong.");
  }

  function openPage(nextPage) {
    clearAlerts();
    setSelectedBook(null);
    setPage(nextPage);
  }

  function chooseRegistrationRole(nextRole) {
    setRegisterRole(normalizeRole(nextRole));
    setRegisterForm({ name: "", membership_id: "", password: "" });
    openPage("register");
  }

  function saveSession(data) {
    if (!data.token || !data.user?.id) {
      throw new Error("The server did not return a valid login session.");
    }

    const savedUser = {
      ...data.user,
      role: normalizeRole(data.user.role),
    };

    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(savedUser));

    setToken(data.token);
    setUser(savedUser);
    setPage("dashboard");
    setMessage(`Welcome, ${savedUser.name || "user"}!`);
  }

  async function handleRegister(event) {
    event.preventDefault();
    clearAlerts();

    if (registerForm.password.length < 8) {
      setError("Your password must contain at least 8 characters.");
      return;
    }

    setBusy(true);

    try {
      await apiRequest("/auth/register", {
        method: "POST",
        body: JSON.stringify({
          name: registerForm.name.trim(),
          membership_id: registerForm.membership_id.trim(),
          password: registerForm.password,
          role: registerRole,
        }),
      });

      setLoginForm({
        membership_id: registerForm.membership_id.trim(),
        password: "",
      });

      setMessage("Registration successful. You can now log in.");
      setPage("login");
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    clearAlerts();
    setBusy(true);

    try {
      const data = await apiRequest("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          membership_id: loginForm.membership_id.trim(),
          password: loginForm.password,
        }),
      });

      saveSession(data);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function loadBooks() {
    const data = await apiRequest("/books", {}, token);
    setBooks(Array.isArray(data) ? data : data.books || []);
  }

  async function loadLoans() {
    const data = await apiRequest("/loans/my", {}, token);
    setLoans(Array.isArray(data) ? data : data.loans || []);
  }

  async function loadUsers() {
    const data = await apiRequest("/admin/users", {}, token);
    setUsers(Array.isArray(data) ? data : data.users || []);
  }

  async function refreshDashboard() {
    if (!token || !user) return;

    setBusy(true);
    clearAlerts();

    try {
      await loadBooks();

      if (role === "Member") {
        await loadLoans();
      } else if (role === "Admin") {
        await loadUsers();
      }
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (token && user) {
      setPage("dashboard");
    }
    // Restores the session when the application is reopened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (page === "dashboard" && authenticated) {
      refreshDashboard();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, token, user?.id]);

  async function handleLogout() {
    clearAlerts();

    try {
      if (token) {
        await apiRequest("/auth/logout", { method: "POST" }, token);
      }
    } catch {
      // Local logout must still work if the server is unreachable.
    } finally {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);

      setToken("");
      setUser(null);
      setBooks([]);
      setLoans([]);
      setUsers([]);
      setSelectedBook(null);
      setPage("home");
      setMessage("You have logged out.");
    }
  }

  async function borrowBook(bookId) {
    clearAlerts();
    setBusy(true);

    try {
      await apiRequest(
        "/loans/borrow",
        {
          method: "POST",
          body: JSON.stringify({ book_id: bookId }),
        },
        token
      );

      setMessage("Book borrowed successfully.");
      await loadBooks();
      await loadLoans();
      setSelectedBook(null);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function returnBook(loanId) {
    clearAlerts();
    setBusy(true);

    try {
      await apiRequest(
        `/loans/${loanId}/return`,
        { method: "POST" },
        token
      );

      setMessage("Book returned successfully.");
      await loadBooks();
      await loadLoans();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  function startAddBook() {
    setEditingBookId(null);
    setBookForm(emptyBookForm);
    openPage("manage-books");
  }

  function startEditBook(book) {
    setEditingBookId(book.id);
    setBookForm({
      title: book.title || "",
      author: book.author || "",
      genre: book.genre || "",
      isbn: book.isbn || "",
      quantity: Number(book.quantity ?? 0),
    });
    openPage("manage-books");
  }

  async function saveBook(event) {
    event.preventDefault();
    clearAlerts();
    setBusy(true);

    const payload = {
      title: bookForm.title.trim(),
      author: bookForm.author.trim(),
      genre: bookForm.genre.trim(),
      isbn: bookForm.isbn.trim(),
      quantity: Number(bookForm.quantity),
    };

    try {
      if (editingBookId) {
        await apiRequest(
          `/books/${editingBookId}`,
          {
            method: "PUT",
            body: JSON.stringify(payload),
          },
          token
        );
        setMessage("Book updated successfully.");
      } else {
        await apiRequest(
          "/books",
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
          token
        );
        setMessage("Book added successfully.");
      }

      setBookForm(emptyBookForm);
      setEditingBookId(null);
      await loadBooks();
      setPage("dashboard");
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function deleteBook(book) {
    if (!window.confirm(`Remove "${book.title}" from the catalogue?`)) {
      return;
    }

    clearAlerts();
    setBusy(true);

    try {
      await apiRequest(`/books/${book.id}`, { method: "DELETE" }, token);
      setMessage("Book removed successfully.");
      setSelectedBook(null);
      await loadBooks();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function createUser(event) {
    event.preventDefault();
    clearAlerts();

    if (newUser.password.length < 8) {
      setError("The password must contain at least 8 characters.");
      return;
    }

    setBusy(true);

    try {
      await apiRequest(
        "/admin/members",
        {
          method: "POST",
          body: JSON.stringify({
            name: newUser.name.trim(),
            membership_id: newUser.membership_id.trim(),
            password: newUser.password,
            role: newUser.role,
          }),
        },
        token
      );

      setNewUser({
        name: "",
        membership_id: "",
        password: "",
        role: "Member",
      });

      setMessage("User created successfully.");
      await loadUsers();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function deleteUser(targetUser) {
    if (Number(targetUser.id) === Number(user?.id)) {
      setError("You cannot delete your own account while logged in.");
      return;
    }

    if (
      !window.confirm(
        `Remove user "${targetUser.name}" (${targetUser.membership_id})?`
      )
    ) {
      return;
    }

    clearAlerts();
    setBusy(true);

    try {
      await apiRequest(
        `/admin/users/${targetUser.id}`,
        { method: "DELETE" },
        token
      );

      setMessage("User removed successfully.");
      await loadUsers();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  function renderAlerts() {
    return (
      <>
        {message && <div className="alert success-alert">{message}</div>}
        {error && <div className="alert error-alert">{error}</div>}
      </>
    );
  }

  function renderHeader() {
    return (
      <header className="site-header">
        <button className="brand" onClick={() => openPage("home")}>
          BookBridge Library
        </button>

        {authenticated ? (
          <nav className="main-nav">
            <span className="signed-in">
              {user?.name} · {role}
            </span>
            <button className="nav-button" onClick={() => openPage("dashboard")}>
              Dashboard
            </button>
            <button className="nav-button" onClick={handleLogout}>
              Log out
            </button>
          </nav>
        ) : (
          <nav className="main-nav">
            <button className="nav-button" onClick={() => openPage("login")}>
              Log in
            </button>
          </nav>
        )}
      </header>
    );
  }

  function renderHome() {
    return (
      <main className="page-container">
        <section className="hero">
          <div>
            <span className="eyebrow">YOUR COMMUNITY LIBRARY</span>
            <h1>Discover a book. Learn something new.</h1>
            <p>
              Browse the library catalogue and manage your books through one
              simple system.
            </p>
            <button onClick={() => openPage("login")}>Log in</button>
          </div>

          <div className="panel">
            <h2>Welcome to BookBridge</h2>
            <p>
              Choose your role to create an account. After registering, log in
              with your membership ID and password.
            </p>
          </div>
        </section>

        <h2>Create an account</h2>
        <div className="role-grid">
          {["Member", "Librarian", "Admin"].map((item) => (
            <article className="role-card" key={item}>
              <h3>{item}</h3>
              <p>
                {item === "Member"
                  ? "Browse the catalogue, borrow books and record returns."
                  : item === "Librarian"
                  ? "Manage the book catalogue and book information."
                  : "Manage user accounts and view account activity."}
              </p>
              <button onClick={() => chooseRegistrationRole(item)}>
                Register as {item}
              </button>
            </article>
          ))}
        </div>
      </main>
    );
  }

  function renderRegister() {
    return (
      <main className="form-page">
        <section className="form-card">
          <h1>Register as {registerRole}</h1>
          <p>Create your BookBridge account.</p>

          <form onSubmit={handleRegister}>
            <div>
              <label htmlFor="register-name">Full name</label>
              <input
                id="register-name"
                required
                value={registerForm.name}
                onChange={(event) =>
                  setRegisterForm({
                    ...registerForm,
                    name: event.target.value,
                  })
                }
              />
            </div>

            <div>
              <label htmlFor="register-membership">Membership ID</label>
              <input
                id="register-membership"
                required
                value={registerForm.membership_id}
                onChange={(event) =>
                  setRegisterForm({
                    ...registerForm,
                    membership_id: event.target.value,
                  })
                }
              />
            </div>

            <div>
              <label htmlFor="register-password">Password</label>
              <input
                id="register-password"
                type="password"
                minLength={8}
                required
                autoComplete="new-password"
                value={registerForm.password}
                onChange={(event) =>
                  setRegisterForm({
                    ...registerForm,
                    password: event.target.value,
                  })
                }
              />
              <small>Use at least 8 characters.</small>
            </div>

            <button type="submit" disabled={busy}>
              {busy ? "Registering..." : "Create account"}
            </button>
          </form>

          <p>
            Already registered?{" "}
            <button className="text-button" onClick={() => openPage("login")}>
              Log in
            </button>
          </p>
        </section>
      </main>
    );
  }

  function renderLogin() {
    return (
      <main className="form-page">
        <section className="form-card">
          <h1>Log in</h1>
          <p>Enter your membership ID and password.</p>

          <form onSubmit={handleLogin}>
            <div>
              <label htmlFor="login-membership">Membership ID</label>
              <input
                id="login-membership"
                required
                autoComplete="username"
                value={loginForm.membership_id}
                onChange={(event) =>
                  setLoginForm({
                    ...loginForm,
                    membership_id: event.target.value,
                  })
                }
              />
            </div>

            <div>
              <label htmlFor="login-password">Password</label>
              <input
                id="login-password"
                type="password"
                required
                autoComplete="current-password"
                value={loginForm.password}
                onChange={(event) =>
                  setLoginForm({
                    ...loginForm,
                    password: event.target.value,
                  })
                }
              />
            </div>

            <button type="submit" disabled={busy}>
              {busy ? "Logging in..." : "Log in"}
            </button>
          </form>

          <p>
            Need an account?{" "}
            <button className="text-button" onClick={() => openPage("home")}>
              Register
            </button>
          </p>
        </section>
      </main>
    );
  }

  function renderBookCatalogue() {
    return (
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Book catalogue</h2>
            <p className="muted">Browse the books currently listed.</p>
          </div>

          {role === "Librarian" && (
            <button onClick={startAddBook}>Add a book</button>
          )}
        </div>

        {books.length === 0 ? (
          <p className="empty-state">
            No books are currently listed in the catalogue.
          </p>
        ) : (
          <div className="book-grid">
            {books.map((book) => (
              <article className="book-card" key={book.id}>
                <h3>{book.title}</h3>
                <p>Author: {book.author || "Not specified"}</p>
                <p>Genre: {book.genre || "Not specified"}</p>
                <p>Available copies: {book.quantity ?? 0}</p>

                <div className="button-row">
                  <button
                    className="secondary-button"
                    onClick={() => setSelectedBook(book)}
                  >
                    View details
                  </button>

                  {role === "Member" && Number(book.quantity) > 0 && (
                    <button
                      disabled={busy}
                      onClick={() => borrowBook(book.id)}
                    >
                      Borrow
                    </button>
                  )}

                  {role === "Librarian" && (
                    <>
                      <button
                        className="secondary-button"
                        onClick={() => startEditBook(book)}
                      >
                        Edit
                      </button>
                      <button
                        className="danger-button"
                        disabled={busy}
                        onClick={() => deleteBook(book)}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}

        {selectedBook && (
          <div className="detail-panel">
            <h3>{selectedBook.title}</h3>
            <p>
              <strong>Author:</strong> {selectedBook.author || "Not specified"}
            </p>
            <p>
              <strong>Genre:</strong> {selectedBook.genre || "Not specified"}
            </p>
            <p>
              <strong>ISBN:</strong> {selectedBook.isbn || "Not specified"}
            </p>
            <p>
              <strong>Available copies:</strong> {selectedBook.quantity ?? 0}
            </p>

            {role === "Member" && Number(selectedBook.quantity) > 0 && (
              <button
                disabled={busy}
                onClick={() => borrowBook(selectedBook.id)}
              >
                Borrow this book
              </button>
            )}

            <button
              className="secondary-button"
              onClick={() => setSelectedBook(null)}
            >
              Close details
            </button>
          </div>
        )}
      </section>
    );
  }

  function renderMemberLoans() {
    const activeLoans = loans.filter(
      (loan) => String(loan.status).toLowerCase() !== "returned"
    );

    return (
      <section className="panel">
        <h2>My borrowed books</h2>
        <p className="muted">
          You may have a maximum of five active borrowed books.
        </p>

        {loans.length === 0 ? (
          <p className="empty-state">You have no borrowing records yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Book</th>
                  <th>Author</th>
                  <th>Borrowed on</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {loans.map((loan) => {
                  const isActive =
                    String(loan.status).toLowerCase() !== "returned";

                  return (
                    <tr key={loan.id}>
                      <td>{loan.title}</td>
                      <td>{loan.author}</td>
                      <td>
                        {loan.loan_date
                          ? String(loan.loan_date).slice(0, 10)
                          : "—"}
                      </td>
                      <td>{loan.status}</td>
                      <td>
                        {isActive ? (
                          <button
                            disabled={busy}
                            onClick={() => returnBook(loan.id)}
                          >
                            Return
                          </button>
                        ) : (
                          "Returned"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p>Active borrowed books: {activeLoans.length}</p>
      </section>
    );
  }

  function renderBookForm() {
    return (
      <main className="form-page">
        <section className="form-card wide-form">
          <h1>{editingBookId ? "Edit book" : "Add a book"}</h1>

          <form onSubmit={saveBook}>
            <div>
              <label htmlFor="book-title">Book title</label>
              <input
                id="book-title"
                required
                value={bookForm.title}
                onChange={(event) =>
                  setBookForm({ ...bookForm, title: event.target.value })
                }
              />
            </div>

            <div>
              <label htmlFor="book-author">Author</label>
              <input
                id="book-author"
                required
                value={bookForm.author}
                onChange={(event) =>
                  setBookForm({ ...bookForm, author: event.target.value })
                }
              />
            </div>

            <div>
              <label htmlFor="book-genre">Genre</label>
              <input
                id="book-genre"
                required
                value={bookForm.genre}
                onChange={(event) =>
                  setBookForm({ ...bookForm, genre: event.target.value })
                }
              />
            </div>

            <div>
              <label htmlFor="book-isbn">ISBN</label>
              <input
                id="book-isbn"
                required
                value={bookForm.isbn}
                onChange={(event) =>
                  setBookForm({ ...bookForm, isbn: event.target.value })
                }
              />
            </div>

            <div>
              <label htmlFor="book-quantity">Quantity</label>
              <input
                id="book-quantity"
                type="number"
                min="0"
                step="1"
                required
                value={bookForm.quantity}
                onChange={(event) =>
                  setBookForm({
                    ...bookForm,
                    quantity: event.target.value,
                  })
                }
              />
            </div>

            <div className="button-row">
              <button type="submit" disabled={busy}>
                {busy
                  ? "Saving..."
                  : editingBookId
                  ? "Save changes"
                  : "Add book"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setEditingBookId(null);
                  setBookForm(emptyBookForm);
                  openPage("dashboard");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      </main>
    );
  }

  function renderAdminPanel() {
    return (
      <>
        <section className="panel">
          <h2>Create a user</h2>

          <form className="inline-form" onSubmit={createUser}>
            <div>
              <label htmlFor="new-user-name">Full name</label>
              <input
                id="new-user-name"
                required
                value={newUser.name}
                onChange={(event) =>
                  setNewUser({ ...newUser, name: event.target.value })
                }
              />
            </div>

            <div>
              <label htmlFor="new-user-membership">Membership ID</label>
              <input
                id="new-user-membership"
                required
                value={newUser.membership_id}
                onChange={(event) =>
                  setNewUser({
                    ...newUser,
                    membership_id: event.target.value,
                  })
                }
              />
            </div>

            <div>
              <label htmlFor="new-user-password">Temporary password</label>
              <input
                id="new-user-password"
                type="password"
                minLength={8}
                required
                value={newUser.password}
                onChange={(event) =>
                  setNewUser({ ...newUser, password: event.target.value })
                }
              />
            </div>

            <div>
              <label htmlFor="new-user-role">Role</label>
              <select
                id="new-user-role"
                value={newUser.role}
                onChange={(event) =>
                  setNewUser({ ...newUser, role: event.target.value })
                }
              >
                <option value="Member">Member</option>
                <option value="Librarian">Librarian</option>
                <option value="Admin">Admin</option>
              </select>
            </div>

            <div className="form-actions">
              <button type="submit" disabled={busy}>
                Create user
              </button>
            </div>
          </form>
        </section>

        <section className="panel">
          <h2>User accounts and login activity</h2>

          {users.length === 0 ? (
            <p className="empty-state">No users were returned by the server.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Membership ID</th>
                    <th>Role</th>
                    <th>Last login</th>
                    <th>Last logout</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((targetUser) => (
                    <tr key={targetUser.id}>
                      <td>{targetUser.name}</td>
                      <td>{targetUser.membership_id}</td>
                      <td>{normalizeRole(targetUser.role)}</td>
                      <td>
                        {targetUser.last_login_at
                          ? String(targetUser.last_login_at).replace("T", " ").slice(0, 19)
                          : "Never"}
                      </td>
                      <td>
                        {targetUser.last_logout_at
                          ? String(targetUser.last_logout_at).replace("T", " ").slice(0, 19)
                          : "Never"}
                      </td>
                      <td>
                        {Number(targetUser.id) === Number(user?.id) ? (
                          <span>Current account</span>
                        ) : (
                          <button
                            className="danger-button"
                            disabled={busy}
                            onClick={() => deleteUser(targetUser)}
                          >
                            Remove user
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </>
    );
  }

  function renderDashboard() {
    if (!authenticated) {
      return renderLogin();
    }

    if (page === "manage-books" && role === "Librarian") {
      return renderBookForm();
    }

    return (
      <main className="page-container">
        <div className="dashboard-heading">
          <div>
            <span className="eyebrow">{role.toUpperCase()} DASHBOARD</span>
            <h1>Welcome, {user?.name || "user"}</h1>
            <p className="muted">
              {role === "Member"
                ? "Browse books and manage your borrowing."
                : role === "Librarian"
                ? "Manage the library book catalogue."
                : "Manage user accounts and review login activity."}
            </p>
          </div>

          <button className="secondary-button" onClick={refreshDashboard}>
            Refresh
          </button>
        </div>

        {role === "Member" && renderMemberLoans()}
        {role === "Admin" && renderAdminPanel()}
        {renderBookCatalogue()}
      </main>
    );
  }

  let content;

  if (page === "home") {
    content = renderHome();
  } else if (page === "register") {
    content = renderRegister();
  } else if (page === "login") {
    content = renderLogin();
  } else if (page === "dashboard" || page === "manage-books") {
    content = renderDashboard();
  } else {
    content = renderHome();
  }

  return (
    <div className="app-shell">
      {renderHeader()}
      {renderAlerts()}
      {content}
      <footer className="site-footer">
        BookBridge Library Management System
      </footer>
    </div>
  );
}

export default App;







