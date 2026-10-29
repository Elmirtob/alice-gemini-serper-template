
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-20b";
const MAX_ALICE_TEXT = 1024;
const MAX_HISTORY = 8;
const GROQ_TIMEOUT_MS = 4500;
const SERPER_TIMEOUT_MS = 700;

const SYSTEM_PROMPT = [
  "Ты — голосовой помощник Яндекс Алисы.",
  "Отвечай на языке пользователя, обычно по-русски.",
  "Будь дружелюбным, точным и кратким.",
  "Обычно отвечай в 1–3 предложениях, удобных для прослушивания.",
  "Не используй Markdown, таблицы и декоративные символы.",
  "Не выдумывай факты. Если информации недостаточно, скажи об этом."
].join(" ");

function aliceResponse(text, history = [], endSession = false) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: {
      history: cleanHistory(history)
    }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text) return "Не удалось подготовить ответ.";
  if (text.length <= MAX_ALICE_TEXT) return text;

  const shortText = text.slice(0, MAX_ALICE_TEXT - 1);
  const punctuation = Math.max(
    shortText.lastIndexOf(". "),
    shortText.lastIndexOf("! "),
    shortText.lastIndexOf("? ")
  );

  if (punctuation >= 300) {
    return shortText.slice(0, punctuation + 1);
  }

  const space = shortText.lastIndexOf(" ");
  return (space > 200 ? shortText.slice(0, space) : shortText) + "…";
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(
      item =>
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.text === "string"
    )
    .slice(-MAX_HISTORY)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, 1000)
    }));
}

function isSearchIntent(text) {
  return /сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные|latest|today|current|news|weather|price|search/i.test(text);
}

function remainingTime(startedAt) {
  return Math.max(100, 9500 - (Date.now() - startedAt));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = new Headers();

    for (const [name, value] of Object.entries(options.headers || {})) {
      const stringValue = String(value);

      // Проверяем HTTP-заголовки до fetch, чтобы точно найти
      // кириллицу или другой недопустимый символ.
      for (let i = 0; i < stringValue.length; i++) {
        const code = stringValue.charCodeAt(i);

        if (code > 255 || code === 10 || code === 13) {
          console.error(
            "Invalid HTTP header value:",
            name,
            "character index:",
            i,
            "character code:",
            code
          );
          throw new Error("INVALID_HTTP_HEADER_" + name);
        }
      }

      headers.set(name, stringValue);
    }

    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal
    });

    const raw = await response.text();
    let data = {};

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { message: raw.slice(0, 500) };
    }

    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 200) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          q: query,
          gl: "ru",
          hl: "ru",
          num: 3
        })
      },
      timeoutMs
    );

    if (!response.ok) {
      console.error("Serper HTTP status:", response.status);
      return "";
    }

    const results = Array.isArray(data.organic) ? data.organic : [];

    return results.slice(0, 3).map((item, index) =>
      `${index + 1}. ${String(item.title || "").slice(0, 150)}. ` +
      `${String(item.snippet || "").slice(0, 300)}`
    ).join("\n");
  } catch (error) {
    console.error("Serper error:", error.message);
    return "";
  }
}

async function askGroq(question, history, searchContext, timeoutMs) {
  const key = process.env.GROQ_API_KEY;

  if (!key || !key.trim()) {
    throw new Error("MISSING_GROQ_KEY");
  }

  const model = (process.env.GROQ_MODEL || DEFAULT_MODEL).trim();

  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT
    }
  ];

  for (const item of cleanHistory(history)) {
    messages.push({
      role: item.role,
      content: item.text
    });
  }

  let userMessage = question;

  if (searchContext) {
    userMessage +=
      "\n\nРезультаты поиска в интернете:\n" +
      searchContext +
      "\nИспользуй эти результаты, если они относятся к вопросу.";
  }

  messages.push({
    role: "user",
    content: userMessage
  });

  let result;

  try {
    result = await fetchJson(
      GROQ_URL,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.trim()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          max_completion_tokens: 300,
          stream: false
        })
      },
      timeoutMs
    );
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("GROQ_TIMEOUT");
    }
    throw error;
  }

  const { response, data } = result;

  if (!response.ok) {
    // Не записываем ключи и полный запрос в логи.
    console.error(
      "Groq HTTP error:",
      response.status,
      String(data?.error?.code || data?.error?.type || "unknown")
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error("GROQ_AUTH_ERROR");
    }

    if (response.status === 429) {
      throw new Error("GROQ_RATE_LIMIT");
    }

    if (response.status === 400 || response.status === 404) {
      throw new Error("GROQ_MODEL_OR_REQUEST_ERROR");
    }

    throw new Error("GROQ_SERVER_ERROR");
  }

  const answer = data?.choices?.[0]?.message?.content;

  if (typeof answer !== "string" || !answer.trim()) {
    console.error("Groq returned an empty answer.");
    throw new Error("GROQ_EMPTY_RESPONSE");
  }

  return answer.trim();
}

function userError(error) {
  switch (error?.message) {
    case "MISSING_GROQ_KEY":
      return "Сервер не настроен. Проверьте переменную GROQ_API_KEY в Vercel.";

    case "GROQ_AUTH_ERROR":
      return "Groq не принял API-ключ. Проверьте ключ в настройках Vercel.";

    case "GROQ_RATE_LIMIT":
      return "Groq временно ограничил количество запросов. Попробуйте позже.";

    case "GROQ_MODEL_OR_REQUEST_ERROR":
      return "Groq отклонил запрос или название модели. Проверьте настройки модели.";

    case "GROQ_TIMEOUT":
      return "Groq не успел ответить. Попробуйте ещё раз.";

    case "GROQ_EMPTY_RESPONSE":
      return "Нейросеть вернула пустой ответ. Попробуйте ещё раз.";

    case "INVALID_HTTP_HEADER_Authorization":
      return "Проверьте API-ключ Groq: в нём обнаружены недопустимые символы.";

    case "INVALID_HTTP_HEADER_X-API-KEY":
      return "Проверьте ключ Serper в настройках Vercel.";

    default:
      return "Не удалось получить ответ от Groq. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-groq-serper",
      message: "Webhook is ready."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const body = req.body && typeof req.body === "object" ? req.body : {};

  const request = body.request || {};
  const question = String(
    request.command || request.original_utterance || ""
  ).trim();

  const history = cleanHistory(
    body.state?.session?.history ||
    body.state?.user?.history ||
    []
  );

  if (!question) {
    return res.status(200).json(
      aliceResponse(
        "Привет! Задай мне вопрос, и я постараюсь помочь.",
        history
      )
    );
  }

  try {
    let searchContext = "";

    if (process.env.SERPER_API_KEY && isSearchIntent(question)) {
      searchContext = await searchWeb(
        question,
        Math.min(SERPER_TIMEOUT_MS, remainingTime(startedAt) - 5000)
      );
    }

    const answer = await askGroq(
      question,
      history,
      searchContext,
      Math.min(GROQ_TIMEOUT_MS, remainingTime(startedAt) - 500)
    );

    const updatedHistory = cleanHistory([
      ...history,
      { role: "user", text: question },
      { role: "assistant", text: answer }
    ]);

    return res.status(200).json(
      aliceResponse(answer, updatedHistory)
    );
  } catch (error) {
    const message = String(error?.message || "UNKNOWN_ERROR");

    // Не выводим секреты, содержимое запросов или ключи в логи.
    console.error("Alice webhook error code:", message);

    return res.status(200).json(
      aliceResponse(userError(error), history)
    );
  }
}
