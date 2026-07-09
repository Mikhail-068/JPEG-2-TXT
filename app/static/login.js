const loginForm = document.querySelector("#loginForm");
const usernameInput = document.querySelector("#username");
const passwordInput = document.querySelector("#password");
const loginError = document.querySelector("#loginError");
const loginSubmit = document.querySelector("#loginSubmit");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    showError("Введите логин и пароль.");
    return;
  }

  loginSubmit.disabled = true;
  loginSubmit.textContent = "Входим…";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (response.ok) {
      window.location.href = "/";
      return;
    }

    const data = await response.json().catch(() => ({}));
    showError(data.detail || "Неверный логин или пароль.");
  } catch {
    showError("Сетевая ошибка. Попробуйте ещё раз.");
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = "Войти";
  }
});

function showError(message) {
  loginError.textContent = message;
  loginError.hidden = false;
}

usernameInput.focus();
