// An interactive terminal belongs to a card, not to a particular render of that card.
// Keep its xterm instance and scrollback when the board redraws around it.
(() => {
  const nonce = document.currentScript?.nonce || "";
  // xterm creates style elements for cell sizing and colors. Give those elements the same
  // CSP nonce as the trusted script; do not relax style-src for arbitrary inline styles.
  const terminalDocument = new Proxy(document, {
    get(target, key) {
      if (key === "createElement") return (name, options) => {
        const element = target.createElement(name, options);
        if (name.toLowerCase() === "style" && nonce) element.nonce = nonce;
        return element;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  // the user, 15 November 2026: the card's terminal uses the colour theme of VS Code's own terminal, the 16 ANSI colours included.
  // A colour the theme leaves empty keeps xterm's default.
  const ANSI = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];
  const terminalTheme = (style) => {
    const get = (...names) => { for (const n of names) { const v = style.getPropertyValue(n).trim(); if (v) return v; } return undefined; };
    const theme = {
      background: get("--vscode-terminal-background", "--vscode-panel-background", "--vscode-editor-background"),
      foreground: get("--vscode-terminal-foreground", "--vscode-editor-foreground"),
      cursor: get("--vscode-terminalCursor-foreground", "--vscode-terminal-foreground", "--vscode-editor-foreground"),
      selectionBackground: get("--vscode-terminal-selectionBackground", "--vscode-editor-selectionBackground"),
    };
    for (const c of ANSI) {
      theme[c.toLowerCase()] = get(`--vscode-terminal-ansi${c}`);
      theme[`bright${c}`] = get(`--vscode-terminal-ansiBright${c}`);
    }
    for (const k of Object.keys(theme)) if (theme[k] === undefined) delete theme[k];
    return theme;
  };
  window.cardTerminalTheme = terminalTheme;

  window.createCardTerminals = (send) => {
    const cards = new Map();
    // VS Code marks a theme change on body's class; every open terminal takes the new colours.
    try {
      new MutationObserver(() => {
        const theme = terminalTheme(getComputedStyle(document.body));
        for (const card of cards.values()) if (card.term) card.term.options.theme = theme;
      }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    } catch { /* no MutationObserver (tests' stand-in): the colours stay as opened */ }
    const isActive = (card) => card.generation != null && card.state === "running" && !card.replaying;
    const sendSize = (id, card) => {
      if (isActive(card) && card.term.cols >= 2 && card.term.cols <= 500 && card.term.rows >= 2 && card.term.rows <= 500)
        send("terminalResize", { id, generation: card.generation, cols: card.term.cols, rows: card.term.rows });
    };
    const fit = (card) => {
      if (!card.open || !card.node.isConnected || !card.screen.clientWidth || !card.screen.clientHeight) return;
      card.fit.fit();
    };
    const mount = (card) => {
      if (!card.node.isConnected || !card.term || !card.screen.clientWidth || !card.screen.clientHeight) return;
      if (!card.open) {
        // The scrollbar uses the real ownerDocument rather than documentOverride.
        // Its style is created synchronously during open; restore the native method immediately.
        const create = document.createElement;
        try {
          document.createElement = function(name, options) {
            const element = create.call(this, name, options);
            if (name.toLowerCase() === "style" && nonce) element.nonce = nonce;
            return element;
          };
          card.term.open(card.screen);
        } catch (error) {
          card.status.textContent = `Terminal could not open: ${error instanceof Error ? error.message : String(error)}`;
          return;
        } finally { document.createElement = create; }
        card.open = true;
        fit(card);
        send("terminalAttach", { id: card.id });
      } else fit(card);
    };
    const make = (task) => {
      const node = document.createElement("section");
      node.className = "card-terminal";
      node.dataset.terminalTask = task.id;
      node.setAttribute("aria-label", `${task.title} terminal`);
      const header = document.createElement("div");
      header.className = "card-terminal-header";
      const label = document.createElement("span"); label.textContent = "Terminal";
      const status = document.createElement("span"); status.className = "muted"; status.textContent = "Connecting…";
      header.append(label, status);
      const screen = document.createElement("div"); screen.className = "card-terminal-screen";
      node.append(header, screen);
      const card = { id: task.id, node, screen, status, generation: undefined, state: "connecting", open: false };
      if (typeof Terminal !== "function" || typeof globalThis.FitAddon?.FitAddon !== "function") {
        status.textContent = "Terminal assets unavailable";
        return card;
      }
      const style = getComputedStyle(document.body);
      card.term = new Terminal({
        documentOverride: terminalDocument,
        cursorBlink: true,
        scrollback: 2000,
        fontFamily: style.getPropertyValue("--vscode-editor-font-family").trim() || "monospace",
        fontSize: 12,
        theme: terminalTheme(style),
        disableStdin: true,
      });
      card.fit = new FitAddon.FitAddon();
      card.term.loadAddon(card.fit);
      // F89: the user's input is everything except xterm's own answers to the program's terminal queries (device attributes, cursor and
      // status reports, focus, colour and mode replies) and mouse reports, unless a key or paste just came before them.
      let userAt = 0;
      card.term.onKey(() => { userAt = Date.now(); });
      screen.addEventListener("paste", () => { userAt = Date.now(); }, true);
      const reply = /^(?:\u001b\[[?>=]?[\d;]*[cRnyt$]|\u001b\[[IO]|\u001b\[<[\d;]+[Mm]|\u001b\[M[\s\S]{3}|\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001bP[\s\S]*?\u001b\\|\u001b\[\?[\d;]*\$y)+$/;
      card.term.onData((data) => { if (isActive(card)) send("terminalInput", { id: task.id, generation: card.generation, data, user: Date.now() - userAt < 500 || !reply.test(data) }); });
      card.term.onResize(() => sendSize(task.id, card));
      card.observer = new ResizeObserver(() => mount(card));
      card.observer.observe(screen);
      return card;
    };
    return {
      view(task) {
        let card = cards.get(task.id);
        if (!card) { card = make(task); cards.set(task.id, card); }
        card.node.setAttribute("aria-label", `${task.title} terminal`);
        card.resumable = !!task.cardTerminalStarted;
        // A refused attach (right after a reload this window owns the board only once its takeover tick succeeds) is asked
        // again on the next render, which every board change and the 15 s usage post bring.
        if (card.open && card.retry) { card.retry = false; send("terminalAttach", { id: task.id }); }
        // The card may be temporarily detached or hidden during a board rebuild. A microtask
        // handles the normal render; the observer retries when it later becomes visible.
        queueMicrotask(() => mount(card));
        requestAnimationFrame(() => mount(card));
        return card.node;
      },
      message(message) {
        if (message?.type === "terminalFocus") { const c = cards.get(message.id); c?.node.scrollIntoView({ block: "nearest" }); if (message.focus) c?.term?.focus(); return true; }
        if (message?.type !== "terminalData" && message?.type !== "terminalState") return false;
        const card = cards.get(message.id);
        if (!card?.term || message.retired) return true;
        if (message.type === "terminalData") {
          if (message.generation === card.generation && typeof message.data === "string") card.term.write(message.data);
          return true;
        }
        if (message.generation !== card.generation) { card.term.reset(); card.generation = message.generation; card.replaying = false; }
        card.state = message.state;
        card.retry = message.state === "unavailable" && typeof message.error === "string";
        const ended = card.resumable ? "Ended with the last window. Press Resume to continue in a new terminal." : "Start the task to open its terminal";
        card.status.textContent = message.state === "running" ? "Live" : message.state === "exited" ? "Exited" : message.state === "unavailable" ? (typeof message.error === "string" ? message.error : ended) : String(message.state || "Connecting…");
        if (typeof message.snapshot === "string") {
          // Replayed terminal output may contain device queries. Never send generated replies
          // back to the live process a second time or accept keys until replay has finished.
          const generation = card.generation;
          card.replaying = true;
          card.term.options.disableStdin = true;
          card.term.reset();
          card.term.write(message.snapshot, () => {
            if (generation !== card.generation) return;
            card.replaying = false;
            card.term.options.disableStdin = !isActive(card);
            if (isActive(card)) { fit(card); sendSize(message.id, card); }
          });
        } else {
          card.term.options.disableStdin = !isActive(card);
          if (isActive(card)) { fit(card); sendSize(message.id, card); }
        }
        return true;
      },
      focus(id) { cards.get(id)?.term?.focus(); },
      prune(tasks) {
        const present = new Set(tasks.filter((task) => task.provider === "grok" || task.provider === "antigravity" || task.cardTerminal).map((task) => task.id));
        for (const [id, card] of cards) if (!present.has(id)) { card.observer?.disconnect(); card.term?.dispose(); cards.delete(id); }
      },
    };
  };
})();
