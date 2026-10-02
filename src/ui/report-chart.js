// Accessible SVG chart; values in BRL are calculated with Decimal in the main process.
window.ReportChart = class {
  constructor(svg, tooltip, onChoose) {
    this.svg = svg;
    this.tooltip = tooltip;
    this.onChoose = onChoose;
    this.signature = null;
    this.index = null;
  }
  render(days, investment = null) {
    const signature = JSON.stringify([days, investment]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.days = days;
    this.index = null;
    this.tooltip.hidden = true;
    const svg = this.svg;
    svg.replaceChildren();
    svg.setAttribute("viewBox", "0 0 1000 320");
    svg.setAttribute("role", "group");
    const fmt = (n) =>
      n == null
        ? "—"
        : Number(n).toLocaleString("pt-BR", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
    this.fmt = fmt;
    const node = (tag, attrs, text) => {
      const el = document.createElementNS(svg.namespaceURI, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      if (text != null) el.textContent = text;
      svg.append(el);
      return el;
    };
    if (!days.length) {
      node(
        "text",
        { x: 500, y: 155, "text-anchor": "middle", class: "chart-axis" },
        "Sem lançamentos neste período",
      );
      return;
    }
    const values = days.map((d) => Number(d.cumulative)),
      lo = Math.min(
        0,
        ...values,
        ...(investment ? [Number(investment.target)] : []),
      ),
      hi = Math.max(
        0,
        ...values,
        ...(investment ? [Number(investment.target)] : []),
      ),
      pad = (hi - lo || 1) * 0.08;
    const min = lo - pad,
      max = hi + pad,
      span = max - min;
    const x = (i) => 125 + (i * 850) / Math.max(1, days.length - 1),
      y = (v) => 265 - ((v - min) * 230) / span;
    this.x = x;
    this.y = y;
    for (let i = 0; i < 5; i++) {
      const v = min + (i * span) / 4,
        pos = y(v);
      node("line", { x1: 125, x2: 975, y1: pos, y2: pos, class: "chart-grid" });
      node(
        "text",
        { x: 112, y: pos + 4, "text-anchor": "end", class: "chart-axis" },
        "US$ " + fmt(v),
      );
    }
    node(
      "text",
      { x: 125, y: 17, class: "chart-axis" },
      days[0]?.forecast ? "Lucro previsto · US$" : "Lucro acumulado · US$",
    );
    const positions = [
      ...new Set([
        0,
        Math.round((days.length - 1) / 4),
        Math.round((days.length - 1) / 2),
        Math.round(((days.length - 1) * 3) / 4),
        days.length - 1,
      ]),
    ];
    for (const i of positions)
      node(
        "text",
        {
          x: x(i),
          y: 297,
          "text-anchor":
            i === 0 ? "start" : i === days.length - 1 ? "end" : "middle",
          class: "chart-axis",
        },
        days[i].day.slice(5).split("-").reverse().join("/"),
      );
    const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    node("polygon", {
      points: `${x(0)},${y(0)} ${points} ${x(days.length - 1)},${y(0)}`,
      fill: "#99efba",
      "fill-opacity": ".07",
    });
    node("polyline", {
      points,
      fill: "none",
      stroke: "#99efba",
      "stroke-width": 3,
      "stroke-linejoin": "round",
      "stroke-dasharray": days[0]?.forecast ? "8 6" : "none",
    });
    if (investment) {
      const pos = y(Number(investment.target));
      node("line", {
        x1: 125,
        x2: 975,
        y1: pos,
        y2: pos,
        stroke: "#f4c779",
        "stroke-dasharray": "5 5",
        "stroke-width": 1.5,
      });
      node(
        "text",
        {
          x: 970,
          y: pos - 7,
          "text-anchor": "end",
          fill: "#f4c779",
          "font-size": 11,
        },
        "Meta · lucro igual aos aportes Pix",
      );
      const index = days.findIndex((d) => d.day === investment.day);
      if (index >= 0)
        node("circle", {
          cx: x(index),
          cy: y(values[index]),
          r: 9,
          fill: "none",
          stroke: "#f4c779",
          "stroke-width": 2,
        });
    }
    this.guide = node("line", {
      x1: 125,
      x2: 125,
      y1: 30,
      y2: 265,
      class: "chart-guide",
      visibility: "hidden",
    });
    this.dots = [];
    days.forEach((d, i) => {
      const dot = node("circle", {
        cx: x(i),
        cy: y(values[i]),
        r: 4,
        fill: "#99efba",
      });
      this.dots.push(dot);
      const hit = node("circle", {
        cx: x(i),
        cy: y(values[i]),
        r: 12,
        fill: "transparent",
        tabindex: 0,
        role: "button",
        class: "chart-hit",
        "aria-label": `${d.day}: acumulado US$ ${fmt(d.cumulative)}, R$ ${fmt(d.brl?.cumulative)}. ${d.forecast ? "Estimativa." : "Enter para ver lançamentos."}`,
      });
      hit.onfocus = () => this.show(i);
      hit.onblur = () => this.hide();
      hit.onclick = () => {
        if (!d.forecast) this.onChoose(d.day);
      };
      hit.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.onChoose(d.day);
        } else if (e.key === "Escape") this.hide();
        else if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
          e.preventDefault();
          const next = Math.max(
            0,
            Math.min(days.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)),
          );
          svg.querySelectorAll(".chart-hit")[next].focus();
          this.show(next);
        }
      };
    });
    svg.onpointermove = (e) => {
      const p = svg.createSVGPoint();
      p.x = e.clientX;
      p.y = e.clientY;
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const local = p.matrixTransform(matrix.inverse());
      const i = Math.max(
        0,
        Math.min(
          days.length - 1,
          Math.round(((local.x - 125) / 850) * Math.max(1, days.length - 1)),
        ),
      );
      this.show(i);
    };
    svg.onpointerleave = () => {
      if (!svg.contains(document.activeElement)) this.hide();
    };
  }
  show(i) {
    if (this.index === i && !this.tooltip.hidden) return;
    if (this.index != null) this.dots[this.index]?.setAttribute("r", 4);
    this.index = i;
    const d = this.days[i],
      tip = this.tooltip;
    this.dots[i].setAttribute("r", 7);
    this.guide.setAttribute("x1", this.x(i));
    this.guide.setAttribute("x2", this.x(i));
    this.guide.setAttribute("visibility", "visible");
    tip.replaceChildren();
    tip.classList.toggle("chart-tooltip-left", i > this.days.length / 2);
    const title = document.createElement("strong");
    title.textContent =
      d.day.split("-").reverse().join("/") +
      (d.baseline
        ? " · Já apurado"
        : d.forecast
          ? " · Estimativa"
          : d.partial
            ? " · Parcial"
            : d.verified
              ? " · Conferido"
              : "");
    tip.append(title);
    for (const [key, label] of d.baseline
      ? [["cumulative", "Lucro já apurado"]]
      : d.forecast
        ? [
            ["cumulative", "Lucro previsto"],
            ["profit", "Lucro previsto no dia"],
          ]
        : [
            ["cumulative", "Lucro acumulado"],
            ["profit", "Lucro do dia"],
            ["margin", "Margem do dia"],
            ["revenue", "Receita"],
            ["consumption", "Consumo"],
            ["fees", "Taxas"],
          ]) {
      const row = document.createElement("div"),
        name = document.createElement("span"),
        value = document.createElement("b"),
        brl = document.createElement("small");
      name.textContent = label;
      if (key === "margin")
        value.textContent = d.margin == null ? "—" : this.fmt(d.margin) + "%";
      else {
        value.textContent = "US$ " + this.fmt(d[key]);
        brl.textContent = " ≈ R$ " + this.fmt(d.brl?.[key]);
        value.append(brl);
      }
      row.append(name, value);
      tip.append(row);
    }
    tip.hidden = false;
  }
  hide() {
    if (this.index != null) this.dots[this.index]?.setAttribute("r", 4);
    this.index = null;
    this.tooltip.hidden = true;
    this.guide?.setAttribute("visibility", "hidden");
  }
};
