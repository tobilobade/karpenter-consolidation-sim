/* Minimal SVG charts: line charts with a shared crosshair, and a node timeline. */
(function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function niceTicks(max, count) {
    if (!(max > 0)) return [0, 1];
    const raw = max / (count || 4);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = [];
    for (let v = 0; v < max + step * 0.999; v += step) ticks.push(+v.toFixed(10));
    return ticks;
  }

  function clock(t, withSeconds) {
    const day = Math.floor(t / 86400);
    const h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
    const pad = (x) => String(x).padStart(2, '0');
    return (day ? `d${day + 1} ` : '') + pad(h) + ':' + pad(m) + (withSeconds ? ':' + pad(s) : '');
  }

  function hourStep(hours) { return hours <= 6 ? 1 : hours <= 12 ? 2 : hours <= 24 ? 3 : 6; }

  // Shared hover state so every chart shows the crosshair at the same time.
  const hover = {
    t: null, pinned: false, subs: new Set(),
    set(t, pin) {
      if (pin === undefined && this.pinned) return; // plain hover never moves a pinned crosshair
      if (pin !== undefined) this.pinned = pin;
      this.t = t;
      this.subs.forEach((f) => f(t));
    },
    clear() { this.subs.clear(); },
  };

  function frame(container, height, duration, yMax, yFormat) {
    const width = Math.max(280, container.clientWidth);
    const m = { l: 48, r: 14, t: 8, b: 22 };
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img' }, container);
    const x = (t) => m.l + ((width - m.l - m.r) * t) / (duration * 3600);
    const y = (v) => height - m.b - ((height - m.t - m.b) * v) / yMax;
    if (yFormat) {
      for (const v of niceTicks(yMax)) {
        if (v > yMax + 1e-9) continue;
        svgEl('line', { class: v === 0 ? 'baseline' : 'gridline', x1: m.l, x2: width - m.r, y1: y(v), y2: y(v) }, svg);
        svgEl('text', { class: 'tick', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = yFormat(v);
      }
    }
    const step = hourStep(duration);
    for (let h = 0; h <= duration; h += step) {
      svgEl('text', { class: 'tick', x: x(h * 3600), y: height - 6, 'text-anchor': h === 0 ? 'start' : h === duration ? 'end' : 'middle' }, svg)
        .textContent = h > 0 && h % 24 === 0 ? `day ${h / 24 + 1}` : clock(h * 3600);
    }
    return { svg, x, y, width, height, m };
  }

  function tooltip(container) {
    const tt = document.createElement('div');
    tt.className = 'tooltip';
    container.appendChild(tt);
    return {
      show(html, px, py) {
        tt.innerHTML = html;
        tt.style.display = 'block';
        const w = tt.offsetWidth, cw = container.clientWidth;
        tt.style.left = Math.min(Math.max(0, px + 12), cw - w) + 'px';
        tt.style.top = py + 'px';
      },
      hide() { tt.style.display = 'none'; },
    };
  }

  /**
   * series: [{ label, cls: 'a'|'b', values: number[] }] sampled every `sampleEvery` seconds.
   */
  function lineChart(container, opts) {
    container.innerHTML = '';
    container.classList.add('chart');
    const head = document.createElement('div');
    head.innerHTML = `<h3>${opts.title}</h3>`;
    if (opts.series.length > 1) {
      head.innerHTML += '<div class="legend">' +
        opts.series.map((s) => `<span><i class="${s.cls}"></i>${s.label}</span>`).join('') + '</div>';
    }
    container.appendChild(head);

    const n = Math.max(...opts.series.map((s) => s.values.length));
    const dataMax = Math.max(0, ...opts.series.map((s) => Math.max(0, ...s.values)));
    const ticks = niceTicks(Math.max(dataMax, opts.minMax || 0));
    const yMax = ticks[ticks.length - 1];
    const f = frame(container, opts.height || 170, opts.duration, yMax, opts.yFormat);
    const tAt = (i) => i * opts.sampleEvery;

    for (const s of opts.series) {
      const d = s.values.map((v, i) => (i ? 'L' : 'M') + f.x(tAt(i)).toFixed(1) + ' ' + f.y(v).toFixed(1)).join('');
      svgEl('path', { class: 'line ' + s.cls, d }, f.svg);
    }

    const cross = svgEl('line', { class: 'crosshair', y1: f.m.t, y2: f.height - f.m.b, visibility: 'hidden' }, f.svg);
    const dots = opts.series.map((s) => svgEl('circle', { class: 'dot ' + s.cls, r: 4, visibility: 'hidden' }, f.svg));
    const tt = tooltip(container);
    const overlay = svgEl('rect', { x: f.m.l, y: 0, width: f.width - f.m.l - f.m.r, height: f.height, fill: 'transparent' }, f.svg);

    const toT = (evt) => {
      const r = f.svg.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * f.width;
      const i = Math.round(((px - f.m.l) / (f.width - f.m.l - f.m.r)) * (n - 1));
      return tAt(Math.max(0, Math.min(n - 1, i)));
    };
    overlay.addEventListener('mousemove', (e) => hover.set(toT(e)));
    overlay.addEventListener('mouseleave', () => hover.set(null));
    overlay.addEventListener('click', (e) => hover.set(hover.pinned ? null : toT(e), !hover.pinned));

    hover.subs.add((t) => {
      if (t === null) {
        cross.setAttribute('visibility', 'hidden');
        dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
        tt.hide();
        return;
      }
      const i = Math.min(n - 1, Math.round(t / opts.sampleEvery));
      const cx = f.x(tAt(i));
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      let rows = '';
      opts.series.forEach((s, k) => {
        const v = s.values[i];
        if (v === undefined) return;
        dots[k].setAttribute('cx', cx);
        dots[k].setAttribute('cy', f.y(v));
        dots[k].setAttribute('visibility', 'visible');
        rows += `<div class="tt-row"><span class="key ${s.cls}"></span>${s.label}: <b>${opts.tipFormat(v)}</b></div>`;
      });
      const scale = f.svg.getBoundingClientRect().width / f.width || 1;
      tt.show(`<div class="tt-head">${clock(tAt(i))}${hover.pinned ? ' · pinned' : ''}</div>${rows}`, cx * scale, head.offsetHeight);
    });
  }

  /** Node timeline (Gantt): one row per node, launching segment lighter. */
  function timeline(container, opts) {
    container.innerHTML = '';
    container.classList.add('chart');
    const head = document.createElement('div');
    head.innerHTML = `<h3>${opts.title}</h3>`;
    container.appendChild(head);

    const nodes = opts.nodes;
    const end = opts.duration * 3600;
    // Small fleets get readable rows; big ones are squeezed into at most ~520px.
    const count = Math.max(1, nodes.length);
    const pitch = count <= 52 ? Math.max(6, Math.min(18, Math.floor(260 / count))) : Math.min(6, 520 / count);
    const gap = pitch >= 10 ? 2 : pitch >= 4 ? 1 : 0;
    const rowH = pitch - gap;
    const height = Math.ceil(nodes.length * pitch) + 30;
    const f = frame(container, height, opts.duration, 1, null);
    const tt = tooltip(container);

    nodes.forEach((nd, i) => {
      const y0 = f.m.t + i * pitch;
      const stop = nd.terminatedAt === null ? end : nd.terminatedAt;
      const readyAt = Math.min(nd.readyAt, stop);
      const g = svgEl('g', {}, f.svg);
      const xs = f.x(nd.createdAt), xr = f.x(readyAt), xe = Math.max(f.x(stop), xs + 1);
      svgEl('rect', { class: 'bar launching ' + opts.cls, x: xs, y: y0, width: Math.max(0.5, xr - xs), height: rowH, rx: rowH >= 4 ? 1.5 : 0 }, g);
      if (xe > xr) svgEl('rect', { class: 'bar ' + opts.cls, x: xr, y: y0, width: xe - xr, height: rowH, rx: rowH >= 4 ? 1.5 : 0 }, g);
      if (rowH >= 12 && xe - xr > nd.type.length * 6 + 8) {
        svgEl('text', { class: 'bar-label', x: xr + 4, y: y0 + rowH - 3 }, g).textContent = nd.type;
      }
      // Hit target spans the whole row so thin bars are still easy to hover.
      const hit = svgEl('rect', { x: f.m.l, y: y0, width: f.width - f.m.l - f.m.r, height: pitch, fill: 'transparent' }, g);
      hit.addEventListener('mousemove', (e) => {
        const r = container.getBoundingClientRect();
        const life = nd.terminatedAt === null ? 'still running at end' : `terminated ${clock(nd.terminatedAt)} (${nd.endReason || 'unknown'})`;
        tt.show(`<div class="tt-head">${nd.name} · ${nd.type} · $${nd.price.toFixed(3)}/hr</div>
          <div>${nd.origin === 'replacement' ? 'launched as consolidation replacement' : 'launched for pending pods'} at ${clock(nd.createdAt)}</div>
          <div>${life}</div>`, e.clientX - r.left, e.clientY - r.top + 12);
      });
      hit.addEventListener('mouseleave', () => tt.hide());
    });

    const cross = svgEl('line', { class: 'crosshair', y1: 0, y2: height - f.m.b, visibility: 'hidden' }, f.svg);
    hover.subs.add((t) => {
      if (t === null) return cross.setAttribute('visibility', 'hidden');
      cross.setAttribute('x1', f.x(t));
      cross.setAttribute('x2', f.x(t));
      cross.setAttribute('visibility', 'visible');
    });
  }

  root.KCharts = { lineChart, timeline, hover, clock };
})(window);
