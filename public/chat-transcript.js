// Keep a bubble's identity through live preview, provider-ID assignment and save.
export function transcriptKeys(turn) {
  const providerId = turn.role === 'user' ? turn.providerItemId : turn.providerResponseId;
  return [...new Set([
    turn.uiKey,
    providerId && `${turn.role}:provider:${providerId}`,
    turn.preview && `${turn.role}:provider:${turn.id}`,
    turn.id && `${turn.role}:turn:${turn.id}`,
  ].filter(Boolean))];
}

export class ChatTranscriptView {
  constructor({container, target, rows, renderRow, following = true, canAutoFollow = () => true, onFollowChange = () => {}}) {
    Object.assign(this, {container, target, renderRow, following, canAutoFollow, onFollowChange});
    this.records = [];
    this.frame = null;
    this.scrollFrame = null;
    this.disposed = false;
    this.motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.listeners = [];
    const listen = (type, callback, options) => {
      container.addEventListener(type, callback, options);
      this.listeners.push([type, callback, options]);
    };
    listen('scroll', () => {
      // Animated following is deliberately behind the growing bottom edge.
      // Its own scroll events must never be mistaken for reading older messages.
      if (this.scrollFrame !== null || performance.now() < this.ignoreScrollUntil) return;
      this.setFollowing(this.canAutoFollow() && this.bottomDistance() < 80);
    }, {passive: true});
    listen('wheel', event => {
      if (event.deltaY < 0) this.pause();
    }, {passive: true});
    listen('touchstart', () => this.pause(), {passive: true});
    listen('pointerdown', event => {
      if (event.target === container) this.pause();
    }, {passive: true});
    listen('keydown', event => {
      if (['ArrowUp', 'PageUp', 'Home', 'ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) this.pause();
    });
    this.resize = new ResizeObserver(() => this.follow());
    this.resize.observe(container);
    // The initial history is already rendered. Adopt it without replaying entrances.
    const nodes = new Map([...target.children].map(node => [node.dataset.chatRow, node]));
    for (const row of rows) {
      const node = nodes.get(transcriptKeys(row)[0]);
      if (node) this.records.push(this.record(node, row));
    }
    this.commit(rows, {initial: true});
  }

  record(node, row) {
    return {node, keys: new Set(transcriptKeys(row)), row: {...row}, signature: JSON.stringify(row), motion: null};
  }

  update(rows) {
    this.pending = rows;
    if (this.frame !== null || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!this.disposed && this.container.isConnected) this.commit(this.pending);
    });
  }

  create(row) {
    const template = document.createElement('template');
    template.innerHTML = this.renderRow(row);
    return this.record(template.content.firstElementChild, row);
  }

  patch(record, row) {
    const signature = JSON.stringify(row);
    if (signature === record.signature) return;
    const bubble = record.node.querySelector('.bubble');
    if (bubble.textContent !== row.text) bubble.textContent = row.text;
    // Text-only deltas touch just one text node. Actions and expanded menus stay put.
    if (JSON.stringify({...record.row, text: ''}) !== JSON.stringify({...row, text: ''})) {
      const fresh = this.create(row).node;
      record.node.className = fresh.className;
      const meta = record.node.querySelector('.turn-meta'), next = fresh.querySelector('.turn-meta');
      if (meta.innerHTML !== next.innerHTML) {
        const open = meta.querySelector('details')?.open;
        meta.innerHTML = next.innerHTML;
        if (open && meta.querySelector('details')) meta.querySelector('details').open = true;
      }
    }
    record.signature = signature;
    record.row = {...row};
  }

  commit(rows, {initial = false} = {}) {
    const top = this.container.getBoundingClientRect().top;
    const anchor = this.following ? null : this.records.find(r => r.node.getBoundingClientRect().bottom > top);
    const anchorTop = anchor?.node.getBoundingClientRect().top;
    const before = new Map(this.records.map(r => [r, {top: r.node.getBoundingClientRect().top, opacity: r.motion ? Number(getComputedStyle(r.node).opacity) : 1}]));
    const aliases = new Map();
    for (const record of this.records) for (const key of record.keys) aliases.set(key, record);
    const used = new Set(), added = new Set();
    const next = rows.map(row => {
      let record = transcriptKeys(row).map(key => aliases.get(key)).find(r => r && !used.has(r));
      if (record) this.patch(record, row);
      else {record = this.create(row); added.add(record);}
      for (const key of transcriptKeys(row)) record.keys.add(key);
      used.add(record);
      return record;
    });
    const structureChanged = next.length !== this.records.length || next.some((r, i) => r !== this.records[i]);
    for (const record of this.records) if (!used.has(record)) {record.motion?.cancel(); record.node.remove();}
    let cursor = this.target.firstElementChild;
    for (const record of next) {
      if (record.node !== cursor) this.target.insertBefore(record.node, cursor);
      cursor = record.node.nextElementSibling;
    }
    this.records = next;
    if (anchor && used.has(anchor)) this.writeScroll(this.container.scrollTop + anchor.node.getBoundingClientRect().top - anchorTop);
    if (!initial && structureChanged && !this.motion.matches) {
      // Move existing rows only on insert/reorder. Never restart their motion for a delta.
      for (const record of next) {
        if (!added.has(record) && !this.following) continue;
        const previous = before.get(record);
        record.motion?.cancel();
        const offset = added.has(record) ? 6 : previous.top - record.node.getBoundingClientRect().top;
        if (!added.has(record) && Math.abs(offset) < 1 && previous.opacity >= .99) continue;
        const motion = record.node.animate([
          {opacity: added.has(record) ? 0 : previous.opacity, transform: `translateY(${offset}px)`},
          {opacity: 1, transform: 'translateY(0)'},
        ], {duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)'});
        record.motion = motion;
        motion.onfinish = () => {if (record.motion === motion) record.motion = null;};
      }
    }
    if (initial && this.following) this.writeScroll(this.container.scrollHeight);
    else this.follow();
  }

  bottomDistance() {
    return this.container.scrollHeight - this.container.clientHeight - this.container.scrollTop;
  }

  capturePosition() {
    const top = this.container.getBoundingClientRect().top;
    const anchor = this.records.find(r => r.node.getBoundingClientRect().bottom > top);
    return {scrollTop: this.container.scrollTop, anchor: anchor?.node, offset: anchor ? anchor.node.getBoundingClientRect().top - top : 0};
  }

  restorePosition(position) {
    // Detaching a scroll container during a page refresh can reset scrollTop.
    // Reattach first, then restore the same visible bubble relative to its viewport.
    this.writeScroll(position.scrollTop);
    if (!this.following && position.anchor?.isConnected) {
      const offset = position.anchor.getBoundingClientRect().top - this.container.getBoundingClientRect().top;
      this.writeScroll(this.container.scrollTop + offset - position.offset);
    }
  }

  writeScroll(top) {
    this.ignoreScrollUntil = performance.now() + 80;
    this.container.scrollTop = top;
  }

  setFollowing(value) {
    if (this.following === value) return;
    this.following = value;
    this.onFollowChange(value);
  }

  pause() {
    this.stopScroll();
    this.ignoreScrollUntil = 0;
    this.setFollowing(false);
  }

  stopScroll() {
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = null;
  }

  follow({resume = false} = {}) {
    if (resume) this.setFollowing(true);
    if (this.disposed || !this.following || !this.container.isConnected) return;
    if (this.motion.matches) {this.stopScroll(); this.writeScroll(this.container.scrollHeight); return;}
    if (this.scrollFrame !== null || this.bottomDistance() < .5) return;
    let last = performance.now();
    const step = now => {
      if (this.disposed || !this.following || !this.container.isConnected) {this.scrollFrame = null; return;}
      const target = Math.max(0, this.container.scrollHeight - this.container.clientHeight);
      const distance = target - this.container.scrollTop;
      const elapsed = Math.min(64, Math.max(1, now - last));
      last = now;
      // Some browsers round scrollTop to whole pixels. Finish before easing can
      // stall on a subpixel step and leave a perpetual animation frame running.
      if (Math.abs(distance) < 3 || this.motion.matches) {this.writeScroll(target); this.scrollFrame = null; return;}
      this.writeScroll(this.container.scrollTop + distance * (1 - Math.exp(-elapsed / 70)));
      this.scrollFrame = requestAnimationFrame(step);
    };
    this.scrollFrame = requestAnimationFrame(step);
  }

  dispose() {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.stopScroll();
    this.resize.disconnect();
    for (const [type, callback, options] of this.listeners) this.container.removeEventListener(type, callback, options);
    for (const record of this.records) record.motion?.cancel();
    this.records = [];
    this.pending = null;
  }
}
