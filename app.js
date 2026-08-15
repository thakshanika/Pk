const { useState, useEffect, useRef, useCallback, useMemo } = React;
const CFG = window.NOVA_CONFIG;

/* ---------------------------------------------------------- */
/*  Utilities                                                  */
/* ---------------------------------------------------------- */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2) + Date.now());

function getSessionId() {
  let s = localStorage.getItem("nova_session_id");
  if (!s) { s = uid(); localStorage.setItem("nova_session_id", s); }
  return s;
}

function timeAgoGroup(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000);
  if (diffDays <= 0) return "අද";
  if (diffDays === 1) return "ඊයේ";
  if (diffDays <= 7) return "පසුගිය දින 7";
  if (diffDays <= 30) return "පසුගිය මාසය";
  return "පරණ";
}

/* ---------------------------------------------------------- */
/*  Markdown rendering                                         */
/* ---------------------------------------------------------- */
marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(raw) {
  const html = marked.parse(raw || "");
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

function MessageContent({ text }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = renderMarkdown(text);

    ref.current.querySelectorAll("pre code").forEach((block) => {
      hljs.highlightElement(block);
    });

    ref.current.querySelectorAll("pre").forEach((pre) => {
      if (pre.parentElement.classList.contains("code-block")) return;
      const codeEl = pre.querySelector("code");
      const lang = (codeEl && codeEl.className.replace("hljs", "").replace("language-", "").trim()) || "text";

      const wrap = document.createElement("div");
      wrap.className = "code-block";
      const head = document.createElement("div");
      head.className = "code-block-head";
      head.innerHTML = `<span>${lang}</span>`;

      const copyBtn = document.createElement("button");
      copyBtn.innerHTML = "⧉ Copy";
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(codeEl ? codeEl.innerText : pre.innerText);
        copyBtn.innerHTML = "✓ Copied";
        setTimeout(() => (copyBtn.innerHTML = "⧉ Copy"), 1500);
      };
      head.appendChild(copyBtn);

      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(head);
      wrap.appendChild(pre);
    });

    ref.current.querySelectorAll("a").forEach((a) => a.setAttribute("target", "_blank"));
  }, [text]);

  return <div className="bubble" ref={ref} />;
}

/* ---------------------------------------------------------- */
/*  Storage layer — Supabase if configured, else localStorage  */
/* ---------------------------------------------------------- */
const USE_SUPABASE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
const sb = USE_SUPABASE ? supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
const SESSION_ID = getSessionId();
const LS_KEY = "nova_conversations_v1";

function lsRead() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
}
function lsWrite(convs) { localStorage.setItem(LS_KEY, JSON.stringify(convs)); }

const Store = {
  async listConversations() {
    if (USE_SUPABASE) {
      const { data, error } = await sb.from("conversations").select("*").eq("session_id", SESSION_ID).order("created_at", { ascending: false });
      if (error) { console.error(error); return []; }
      return data;
    }
    return lsRead().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },

  async createConversation(title) {
    const conv = { id: uid(), session_id: SESSION_ID, title: title || "නව සංවාදය", created_at: new Date().toISOString(), messages: [] };
    if (USE_SUPABASE) {
      const { error } = await sb.from("conversations").insert({ id: conv.id, session_id: SESSION_ID, title: conv.title, created_at: conv.created_at });
      if (error) console.error(error);
    } else {
      const all = lsRead(); all.push(conv); lsWrite(all);
    }
    return conv;
  },

  async renameConversation(id, title) {
    if (USE_SUPABASE) {
      await sb.from("conversations").update({ title }).eq("id", id);
    } else {
      const all = lsRead(); const c = all.find((x) => x.id === id); if (c) c.title = title; lsWrite(all);
    }
  },

  async deleteConversation(id) {
    if (USE_SUPABASE) {
      await sb.from("messages").delete().eq("conversation_id", id);
      await sb.from("conversations").delete().eq("id", id);
    } else {
      lsWrite(lsRead().filter((x) => x.id !== id));
    }
  },

  async listMessages(convId) {
    if (USE_SUPABASE) {
      const { data, error } = await sb.from("messages").select("*").eq("conversation_id", convId).order("created_at", { ascending: true });
      if (error) { console.error(error); return []; }
      return data;
    }
    const c = lsRead().find((x) => x.id === convId);
    return (c && c.messages) || [];
  },

  async addMessage(convId, msg) {
    const full = { id: uid(), conversation_id: convId, created_at: new Date().toISOString(), ...msg };
    if (USE_SUPABASE) {
      await sb.from("messages").insert(full);
    } else {
      const all = lsRead(); const c = all.find((x) => x.id === convId);
      if (c) { c.messages = c.messages || []; c.messages.push(full); lsWrite(all); }
    }
    return full;
  },

  async deleteMessage(convId, msgId) {
    if (USE_SUPABASE) {
      await sb.from("messages").delete().eq("id", msgId);
    } else {
      const all = lsRead(); const c = all.find((x) => x.id === convId);
      if (c) { c.messages = (c.messages || []).filter((m) => m.id !== msgId); lsWrite(all); }
    }
  },
};

/* ---------------------------------------------------------- */
/*  Codex AI API call                                           */
/* ---------------------------------------------------------- */
async function askCodex({ message, history, imageUrl, signal }) {
  const endpoint = localStorage.getItem("nova_endpoint") || CFG.AI_ENDPOINT;
  const apiKey = localStorage.getItem("nova_api_key") || CFG.AI_API_KEY;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ message, history, session: SESSION_ID, image_url: imageUrl || undefined }),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${t || res.statusText}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.reply ?? "";
}

/* ---------------------------------------------------------- */
/*  Icons (inline SVG, no external icon font)                  */
/* ---------------------------------------------------------- */
const Icon = {
  plus: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  menu: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  send: <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 12l16-8-6 8 6 8-16-8z" fill="currentColor"/></svg>,
  stop: <svg width="13" height="13" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>,
  image: <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15l-5-5-9 9" stroke="currentColor" strokeWidth="2"/></svg>,
  trash: <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  edit: <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  copy: <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M5 15V5a2 2 0 012-2h10" stroke="currentColor" strokeWidth="2"/></svg>,
  refresh: <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 12a9 9 0 0115.4-6.4L21 8M21 3v5h-5M21 12a9 9 0 01-15.4 6.4L3 16m0 5v-5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  gear: <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="1.6"/></svg>,
  sun: <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  moon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>,
  close: <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  search: <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
};

const SUGGESTIONS = [
  { title: "අදහසක් හදන්න", body: "instagram bio එකක් ලස්සනට ලියලා දෙන්න" },
  { title: "පැහැදිලි කරන්න", body: "black hole එකක් කියන්නේ මොකක්ද කෙටියෙන්" },
  { title: "code එකක් ලියන්න", body: "python වලින් to-do list app එකක් හදන්නේ කොහොමද" },
  { title: "පරිවර්තනය", body: "\"Have a nice day\" කියන්නේ සිංහලෙන් කොහොමද" },
];

/* ---------------------------------------------------------- */
/*  App                                                         */
/* ---------------------------------------------------------- */
function App() {
  const [theme, setTheme] = useState(localStorage.getItem("nova_theme") || "dark");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(window.innerWidth < 860);
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("nova_theme", theme);
  }, [theme]);

  useEffect(() => { refreshConversations(); }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  async function refreshConversations() {
    const list = await Store.listConversations();
    setConversations(list);
  }

  async function openConversation(id) {
    setActiveId(id);
    setError("");
    const msgs = await Store.listMessages(id);
    setMessages(msgs);
    if (window.innerWidth < 860) setSidebarCollapsed(true);
  }

  function startNewChat() {
    setActiveId(null);
    setMessages([]);
    setError("");
    if (window.innerWidth < 860) setSidebarCollapsed(true);
  }

  async function handleDeleteConv(id, e) {
    e.stopPropagation();
    await Store.deleteConversation(id);
    if (id === activeId) startNewChat();
    refreshConversations();
  }

  async function handleRenameConv(id, e) {
    e.stopPropagation();
    const current = conversations.find((c) => c.id === id);
    const title = prompt("නම වෙනස් කරන්න:", current ? current.title : "");
    if (title && title.trim()) {
      await Store.renameConversation(id, title.trim());
      refreshConversations();
    }
  }

  function handleFilePick(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPendingImage(reader.result);
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  async function handleSend(overrideText) {
    const text = (overrideText ?? input).trim();
    if (!text && !pendingImage) return;
    if (loading) return;

    setError("");
    let convId = activeId;
    if (!convId) {
      const conv = await Store.createConversation(text.slice(0, 40) || "සංවාදය");
      convId = conv.id;
      setActiveId(convId);
      refreshConversations();
    }

    const userMsg = await Store.addMessage(convId, { role: "user", content: text, image_url: pendingImage || null });
    const historyForApi = messages.map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    const imgToSend = pendingImage;
    setPendingImage(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const reply = await askCodex({ message: text, history: historyForApi, imageUrl: imgToSend, signal: controller.signal });
      const aiMsg = await Store.addMessage(convId, { role: "assistant", content: reply });
      setMessages((prev) => [...prev, aiMsg]);
      if (!activeId) refreshConversations();
    } catch (err) {
      if (err.name === "AbortError") {
        setError("නවත්වන ලදී.");
      } else {
        console.error(err);
        setError(err.message || "යමක් වැරදුනා. නැවත උත්සාහ කරන්න.");
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  function handleStop() {
    if (abortRef.current) abortRef.current.abort();
  }

  async function handleRegenerate() {
    if (loading || messages.length === 0) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const lastAi = messages[messages.length - 1];
    if (lastAi.role === "assistant") {
      await Store.deleteMessage(activeId, lastAi.id);
      setMessages((prev) => prev.slice(0, -1));
    }
    setLoading(true);
    const historyForApi = messages.slice(0, -1).filter((m) => m.id !== lastAi.id).map((m) => ({ role: m.role, content: m.content }));
    try {
      const reply = await askCodex({ message: lastUser.content, history: historyForApi, imageUrl: lastUser.image_url });
      const aiMsg = await Store.addMessage(activeId, { role: "assistant", content: reply });
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      setError(err.message || "යමක් වැරදුනා.");
    } finally {
      setLoading(false);
    }
  }

  function copyMsg(text) { navigator.clipboard.writeText(text); }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const filteredConvs = useMemo(() => {
    if (!search.trim()) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()));
  }, [conversations, search]);

  const grouped = useMemo(() => {
    const g = {};
    filteredConvs.forEach((c) => {
      const label = timeAgoGroup(c.created_at);
      g[label] = g[label] || [];
      g[label].push(c);
    });
    return g;
  }, [filteredConvs]);

  return (
    <div className="app-shell">
      {!sidebarCollapsed && window.innerWidth < 860 && (
        <div className="sidebar-scrim" onClick={() => setSidebarCollapsed(true)} />
      )}

      <aside className={"sidebar" + (sidebarCollapsed ? " collapsed" : "")}>
        <div className="brand"><span className="brand-orb"></span>{CFG.APP_NAME}</div>

        <button className="new-chat-btn" onClick={startNewChat}>{Icon.plus} නව සංවාදය</button>

        <div style={{ padding: "0 14px" }}>
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 10, top: 9, color: "var(--text-faint)" }}>{Icon.search}</span>
            <input
              className="sidebar-search"
              style={{ paddingLeft: 28, width: "100%" }}
              placeholder="සොයන්න..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="conv-list">
          {Object.keys(grouped).length === 0 && (
            <div style={{ color: "var(--text-faint)", fontSize: 12.5, padding: "16px 10px" }}>සංවාද නැත</div>
          )}
          {Object.entries(grouped).map(([label, convs]) => (
            <div key={label}>
              <div className="conv-group-label">{label}</div>
              {convs.map((c) => (
                <div key={c.id} className={"conv-item" + (c.id === activeId ? " active" : "")} onClick={() => openConversation(c.id)}>
                  <span className="title">{c.title}</span>
                  <div className="conv-actions">
                    <button className="icon-btn" onClick={(e) => handleRenameConv(c.id, e)} title="නම වෙනස් කරන්න">{Icon.edit}</button>
                    <button className="icon-btn" onClick={(e) => handleDeleteConv(c.id, e)} title="මකන්න">{Icon.trash}</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <button className="pill-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? Icon.sun : Icon.moon} {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button className="pill-btn" onClick={() => setSettingsOpen(true)}>{Icon.gear} Settings</button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button className="hamburger" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>{Icon.menu}</button>
          <div className="model-pill"><span className="dot"></span> Codex AI</div>
          <div className="topbar-spacer"></div>
          {!USE_SUPABASE && <div style={{ fontSize: 11, color: "var(--text-faint)" }}>local storage mode</div>}
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-orb"></div>
              <h1>ආයුබෝවන් 👋</h1>
              <p>මම {CFG.APP_NAME}. මොකක් හරි අහන්න, photo එකක් attach කරන්න, හෝ පහත suggestion එකක් try කරන්න.</p>
              <div className="suggestion-grid">
                {SUGGESTIONS.map((s, i) => (
                  <button key={i} className="suggestion-card" onClick={() => handleSend(s.body)}>
                    <b>{s.title}</b>{s.body}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-inner">
              {messages.map((m, i) => (
                <div key={m.id || i} className={"msg-row " + (m.role === "user" ? "user" : "ai")}>
                  <div className={"avatar " + (m.role === "user" ? "user" : "ai") + (loading && i === messages.length - 1 && m.role === "assistant" ? " streaming" : "")}>
                    {m.role === "user" ? "You" : "N"}
                  </div>
                  <div className="bubble-col">
                    {m.image_url && <img className="attach-thumb" src={m.image_url} alt="attachment" />}
                    {m.role === "assistant" ? <MessageContent text={m.content} /> : <div className="bubble">{m.content}</div>}
                    <div className="msg-actions">
                      <button className="icon-btn" onClick={() => copyMsg(m.content)} title="Copy">{Icon.copy}</button>
                      {m.role === "assistant" && i === messages.length - 1 && (
                        <button className="icon-btn" onClick={handleRegenerate} title="Regenerate">{Icon.refresh}</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {loading && (
                <div className="msg-row ai">
                  <div className="avatar ai streaming">N</div>
                  <div className="bubble-col">
                    <div className="bubble"><div className="typing-dots"><span></span><span></span><span></span></div></div>
                  </div>
                </div>
              )}

              {error && <div className="banner">{error}</div>}
            </div>
          )}
        </div>

        {pendingImage && (
          <div className="pending-attachments">
            <div className="pending-thumb">
              <img src={pendingImage} alt="pending" />
              <button className="rm" onClick={() => setPendingImage(null)}>{Icon.close}</button>
            </div>
          </div>
        )}

        <div className="composer-wrap">
          <div className="composer">
            <button className="attach-btn" onClick={() => fileInputRef.current.click()} title="Attach image">{Icon.image}</button>
            <input type="file" accept="image/*" ref={fileInputRef} style={{ display: "none" }} onChange={handleFilePick} />
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="පණිවිඩයක් ලියන්න..."
              value={input}
              onChange={(e) => { setInput(e.target.value); autoResize(); }}
              onKeyDown={handleKeyDown}
            />
            {loading ? (
              <button className="stop-btn" onClick={handleStop} title="Stop">{Icon.stop}</button>
            ) : (
              <button className="send-btn" disabled={!input.trim() && !pendingImage} onClick={() => handleSend()} title="Send">{Icon.send}</button>
            )}
          </div>
          <div className="composer-hint">Enter — යවන්න · Shift+Enter — අළුත් පේළියක්</div>
        </div>
      </main>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function SettingsModal({ onClose }) {
  const [endpoint, setEndpoint] = useState(localStorage.getItem("nova_endpoint") || CFG.AI_ENDPOINT);
  const [apiKey, setApiKey] = useState(localStorage.getItem("nova_api_key") || CFG.AI_API_KEY);

  function save() {
    localStorage.setItem("nova_endpoint", endpoint);
    localStorage.setItem("nova_api_key", apiKey);
    onClose();
  }

  function clearAll() {
    if (confirm("සියලුම සංවාද local storage එකෙන් මකන්නද?")) {
      localStorage.removeItem("nova_conversations_v1");
      location.reload();
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>{Icon.close}</button>
        <h2>Settings</h2>
        <p className="sub">API connection details. මේවා browser එකේ localStorage එකේ save වෙනවා.</p>

        <div className="field">
          <label>API Endpoint</label>
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
        </div>
        <div className="field">
          <label>API Key</label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </div>

        <div className="field" style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <label>Storage mode</label>
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
            {USE_SUPABASE ? "Supabase (cloud)" : "Local Storage (browser එකේ පමණි) — Supabase connect කරන්න config.js එකේ"}
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={clearAll} style={{ color: "var(--danger)", marginRight: "auto" }}>සියල්ල මකන්න</button>
          <button className="btn" onClick={onClose}>අවලංගු</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

