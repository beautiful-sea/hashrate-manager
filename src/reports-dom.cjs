// Runs only in dedicated, read-only report views. No credentials or requests.
function collectReport(site) {
  const text = (n) => (n?.textContent || "").replace(/\s+/g, " ").trim();
  const balance = (label) => {
    const nodes = [...document.querySelectorAll("p")].filter(
      (n) => text(n).toLowerCase() === label,
    );
    const values = [
      ...new Set(
        nodes
          .map((n) => text(n.nextElementSibling))
          .filter((v) => /^US\$\s*[\d.,]+$/.test(v)),
      ),
    ];
    return values.length === 1 ? values[0] : null;
  };
  const visible = (n) => !n.closest("[hidden],[inert]");
  const choose = (nodes) => {
    const active = nodes.filter(visible);
    const selected = active.length ? active : nodes;
    if (selected.length !== 1)
      throw Error("Extrato ausente ou ambíguo. Confira o login.");
    return selected[0];
  };
  const headers = (t) =>
    [...t.querySelectorAll("thead th")].map(text).join("|");
  const pageLink = (href, parameter) => {
    const u = new URL(href, location.href);
    if (
      u.origin !== location.origin ||
      u.pathname !== location.pathname ||
      [...u.searchParams.keys()].some((k) => k !== parameter)
    )
      throw Error("Paginação fora do extrato.");
    const page = Number(u.searchParams.get(parameter) || 1);
    if (!Number.isSafeInteger(page) || page < 1)
      throw Error("Página inválida.");
    return { page, url: u.href };
  };
  const current = pageLink(
    location.href,
    site === "hashsell" ? "page" : site === "payments" ? "saques" : "extrato",
  ).page;
  if (site === "hashsell") {
    const table = choose(
      [...document.querySelectorAll("table")].filter(
        (t) => headers(t) === "Quando|Lançamento|Carteira|Ordem|Valor",
      ),
    );
    const account = text(
      document.querySelector('button[aria-label^="Conta de "]'),
    ).match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0];
    if (!account) throw Error("Identificação da conta Hashsell indisponível.");
    const rows = [...table.querySelectorAll("tbody tr")].map((tr) => {
      const c = [...tr.querySelectorAll("td")];
      const at = c[0]?.querySelector("time")?.getAttribute("datetime");
      if (c.length !== 5 || !at)
        throw Error("Lançamento Hashsell sem data completa.");
      return {
        at,
        displayed: text(c[0]),
        label: (() => {
          const walker = document.createTreeWalker(c[1], 4),
            parts = [];
          while (walker.nextNode()) {
            const value = walker.currentNode.textContent.trim();
            if (value) parts.push(value);
          }
          return parts.join(" ");
        })(),
        wallet: text(c[2]),
        order: text(c[3]),
        amount: text(c[4]),
      };
    });
    const nexts = [...document.querySelectorAll("a[href]")].filter(
      (a) => visible(a) && text(a) === "Próxima",
    );
    if (nexts.length > 1) throw Error("Paginação Hashsell ambígua.");
    const next = nexts[0] ? pageLink(nexts[0].href, "page") : null;
    let counter,
      container = table.parentElement;
    for (
      let i = 0;
      i < 4 && container && !counter;
      i++, container = container.parentElement
    ) {
      const copy = container.cloneNode(true);
      copy.querySelectorAll("table,script,[hidden]").forEach((n) => n.remove());
      const candidates = [copy, ...copy.querySelectorAll("*")]
        .map(text)
        .filter((s) => /^\d+\s*[–-]\s*\d+\s+de\s+\d+$/.test(s));
      if (candidates.length)
        counter = candidates
          .sort((a, b) => a.length - b.length)[0]
          .match(/(\d+)\s*[–-]\s*(\d+)\s+de\s+(\d+)/);
    }
    return {
      account,
      capital: balance("total"),
      rows,
      current,
      next,
      counter: counter ? counter.slice(1).map(Number) : null,
      checks: [],
    };
  }
  // Next.js embeds rendered row keys (full UTC instants) in JSON Flight records.
  // Decode data only; never execute scripts, inspect cookies or read password inputs.
  const payload = [...document.querySelectorAll("script:not([src])")]
    .flatMap((s) => {
      try {
        const a = JSON.parse(s.textContent.match(/push\((\[.*\])\)/s)?.[1]);
        return a[0] === 1 && typeof a[1] === "string" ? [a[1]] : [];
      } catch {
        return [];
      }
    })
    .join("");
  if (payload.length > 10000000)
    throw Error("Extrato excede o limite de leitura.");
  const identities = new Set(),
    dated = [],
    records = new Map();
  for (const line of payload.split("\n")) {
    const index = line.indexOf(":");
    if (index < 1) continue;
    try {
      records.set(line.slice(0, index), JSON.parse(line.slice(index + 1)));
    } catch {
      /* Typed Flight record. */
    }
  }
  const resolve = (v, seen = new Set()) => {
    if (typeof v === "string" && /^\$(?:L)?[0-9a-f]+$/.test(v)) {
      const id = v.replace(/^\$L?/, "");
      if (!records.has(id) || seen.has(id)) return v;
      return resolve(records.get(id), new Set([...seen, id]));
    }
    if (Array.isArray(v)) return v.map((x) => resolve(x, seen));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, resolve(x, seen)]),
      );
    return v;
  };
  const reactText = (v) => {
    if (typeof v === "string" || typeof v === "number") return String(v);
    if (Array.isArray(v))
      return v[0] === "$"
        ? reactText(v[3]?.children)
        : v.map(reactText).join("");
    return "";
  };
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (
      !Array.isArray(v) &&
      typeof v.name === "string" &&
      typeof v.email === "string" &&
      typeof v.status === "string" &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)
    )
      identities.add(v.email.toLowerCase());
    if (
      Array.isArray(v) &&
      v[0] === "$" &&
      v[1] === "tr" &&
      /^\d{4}-\d{2}-\d{2}T/.test(v[2] || "")
    ) {
      const cells = v[3]?.children;
      if (
        Array.isArray(cells) &&
        cells.length === 5 &&
        cells.every((c) => c?.[1] === "td")
      )
        dated.push({
          at: v[2],
          hour: reactText(cells[0]),
          amount: reactText(cells[4]).replace(/\s+/g, " ").trim(),
        });
    }
    for (const child of Object.values(v)) walk(child);
  };
  for (const record of records.values()) walk(resolve(record));
  const metadata = [
    ...new Map(dated.map((r) => [JSON.stringify(r), r])).values(),
  ];
  if (identities.size !== 1)
    throw Error("Identificação da conta RentalHash indisponível ou ambígua.");
  if (site === "payments") {
    const heading = [...document.querySelectorAll("h2")].find(
      (n) => text(n) === "Histórico de pagamentos",
    );
    const container = heading?.parentElement.parentElement.parentElement;
    if (!container) throw Error("Histórico de pagamentos ausente.");
    const items = [...container.querySelectorAll("ul > li")];
    if (!items.length)
      throw Error("Histórico de pagamentos vazio ou indisponível.");
    const rows = items.map((li) => {
      const parts = [...li.querySelectorAll("p")].map(text);
      const info = parts.find((t) =>
        /^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}/.test(t),
      );
      const date = info?.match(/^(\d{2})\/(\d{2})\/(\d{4}), (\d{2}:\d{2})/);
      const fee = info?.match(/taxa (US\$\s*[\d.,]+)/i)?.[1];
      const status = [...li.querySelectorAll("span")]
        .map(text)
        .find((t) =>
          [
            "Concluído",
            "Pendente",
            "Cancelado",
            "Falhou",
            "Processando",
          ].includes(t),
        );
      const id = li
        .querySelector('a[href*="etherscan.io/tx/"]')
        ?.textContent.trim();
      if (!date || !fee || !status)
        throw Error("Pagamento sem data, taxa ou situação reconhecida.");
      const amounts = [
        ...new Set(
          [...li.querySelectorAll("span")]
            .filter((n) => !n.children.length)
            .map(text)
            .filter((v) => /^US\$\s*[\d.,]+$/.test(v)),
        ),
      ];
      return {
        gross: amounts.length === 1 ? amounts[0] : null,
        day: date[3] + "-" + date[2] + "-" + date[1],
        displayedAt: date[0],
        fee,
        status,
        id: id || null,
      };
    });
    const links = [...document.querySelectorAll("a[href]")]
      .filter((a) => {
        const u = new URL(a.href);
        return (
          u.searchParams.has("saques") &&
          !u.searchParams.has("extrato") &&
          !u.hash
        );
      })
      .map((a) => pageLink(a.href, "saques"));
    const next = links.find((p) => p.page === current + 1) || null;
    if (!next && links.some((p) => p.page > current))
      throw Error("Paginação de pagamentos incompleta.");
    return { account: [...identities][0], rows, current, next };
  }
  const all = [...document.querySelectorAll("details")].filter((d) =>
    [...d.querySelectorAll("table")].some(
      (t) => headers(t) === "Hora|Direto|Marketplace|Nível|Crédito",
    ),
  );
  const active = all.filter(visible),
    groups = active.length ? active : all;
  if (!groups.length)
    throw Error("Extrato RentalHash ausente. Confira o login.");
  const rows = [],
    checks = [],
    days = new Set();
  const dateParts = (at) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(at))
        .map((p) => [p.type, p.value]),
    );
  for (const group of groups) {
    group.open = true;
    const summary = [...group.querySelectorAll("summary span")]
      .map(text)
      .join(" ");
    const date = summary.match(/\b(\d{2})\/(\d{2})\b/);
    const total = summary.match(/US\$\s*[\d.,]+/)?.[0];
    const expected = Number(
      [...group.querySelectorAll("summary span")]
        .map(text)
        .find((s) => /^\d+\s+horas?$/.test(s))
        ?.match(/^\d+/)?.[0],
    );
    if (!date || !total || !expected)
      throw Error("Resumo diário RentalHash não reconhecido.");
    const table = choose(
      [...group.querySelectorAll("table")].filter(
        (t) => headers(t) === "Hora|Direto|Marketplace|Nível|Crédito",
      ),
    );
    const daily = [...table.querySelectorAll("tbody tr")];
    if (daily.length !== expected)
      throw Error("Créditos horários incompletos.");
    let day;
    for (const tr of daily) {
      const c = [...tr.querySelectorAll("td")];
      const hour = text(c[0]),
        amount = text(c[4]);
      const matches = metadata.filter((r) => {
        const p = dateParts(r.at);
        return (
          p.day === date[1] &&
          p.month === date[2] &&
          `${p.hour}:${p.minute}` === hour &&
          r.hour === hour &&
          r.amount === amount
        );
      });
      if (c.length !== 5 || matches.length !== 1)
        throw Error("Data completa do crédito não pôde ser comprovada.");
      const at = matches[0].at,
        p = dateParts(at);
      day = `${p.year}-${p.month}-${p.day}`;
      rows.push({
        at,
        displayed: `${date[1]}/${date[2]}, ${hour}`,
        amount,
        label: "Crédito horário",
        wallet: "",
        order: "",
      });
    }
    if (days.has(day)) throw Error("Dia repetido no extrato RentalHash.");
    days.add(day);
    checks.push({ day, total, count: expected });
  }
  const links = [...document.querySelectorAll("a[href]")]
    .filter((a) => {
      const u = new URL(a.href);
      return (
        u.searchParams.has("extrato") &&
        !u.searchParams.has("saques") &&
        !u.hash
      );
    })
    .map((a) => pageLink(a.href, "extrato"));
  const next = links.find((p) => p.page === current + 1) || null;
  if (!next && links.some((p) => p.page > current))
    throw Error("Paginação RentalHash incompleta.");
  return {
    account: [...identities][0],
    capital: balance("saldo disponível"),
    rows,
    checks,
    current,
    next,
    counter: null,
  };
}
const reportScript = (site) =>
  `(()=>{try{return {ok:true,value:(${collectReport.toString()})(${JSON.stringify(site)})}}catch(e){return {ok:false,error:String(e.message)}}})()`;
module.exports = { collectReport, reportScript };
