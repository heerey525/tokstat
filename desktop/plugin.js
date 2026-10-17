import { host, usePluginI18n, useValue, atom } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useEffect } from 'react'

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const exact = new Intl.NumberFormat('en-US')

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function fmtExact(v) { return v === null ? '-' : exact.format(v) }
function fmtCompact(v) { return v === null ? '-' : compact.format(v) }

// ---------------------------------------------------------------------------
// i18n — two host rules this bundle has to obey:
//  1. Bundles MUST be nested trees. The host resolves a key by walking the
//     tree on '.', so a flat `'label.total': '…'` entry is unreachable: the
//     lookup asks for messages.label.total, finds nothing in ANY locale, and
//     returns the raw key. Call sites keep using the dotted path.
//  2. Interpolated messages MUST be functions. A plain string is returned
//     verbatim — `{0}` is NOT substituted (that convenience exists only for
//     app-level language packs, not plugin bundles).
// ---------------------------------------------------------------------------
const STRINGS = {
  en: {
    label: { total: 'Total', turn: 'Turn', last: 'Last', ctx: 'Context', cache: 'Cache' },
    tip: {
      total: (total, input, output) => `Total: ${total} (input ${input} / output ${output})`,
      turn: (total, input, output) => `This turn (running): ${total} (input ${input} / output ${output})`,
      last: (total, input, output) => `Last turn: ${total} (input ${input} / output ${output})`,
      cache: pct => `Cache hit: ${pct}% (higher means cheaper)`,
      ctx: pct => `Context used: ${pct}%`,
      model: name => `Model: ${name}`,
      legend: '"Turn" counts the reply currently generating; "Last" is the previous one.',
      idle: 'No usage reported yet for the focused session.',
    },
  },
  zh: {
    label: { total: '总量', turn: '本轮', last: '上轮', ctx: '上下文', cache: '缓存' },
    tip: {
      total: (total, input, output) => `总量：累计 ${total}（输入 ${input} / 输出 ${output}）`,
      turn: (total, input, output) => `本轮（进行中）：${total}（输入 ${input} / 输出 ${output}）`,
      last: (total, input, output) => `上轮：${total}（输入 ${input} / 输出 ${output}）`,
      cache: pct => `缓存命中：${pct}%（命中越多越省钱）`,
      ctx: pct => `上下文占用：${pct}%`,
      model: name => `模型：${name}`,
      legend: '「本轮」= 正在生成的这一回；「上轮」= 上一个回答',
      idle: '聚焦会话还没有上报用量。',
    },
  },
}

// ---------------------------------------------------------------------------
// Normalize a usage source into { input, output, total, cacheHit, ctxPct, model }.
// Two payload shapes appear on `session.usage` events:
//   (a) gateway ticker:        payload.usage = _get_usage() dict
//   (b) canonical local view:  top-level total_tokens / context_tokens / ...
// `message.complete` (when it carries usage) uses shape (a) under payload.usage.
// ---------------------------------------------------------------------------
function normalize(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = num(usage.input) ?? num(usage.input_tokens)
  const output = num(usage.output) ?? num(usage.output_tokens)
  let total = num(usage.total) ?? num(usage.total_tokens)
  if (total === null && input !== null && output !== null) total = input + output
  let cacheHit = num(usage.cache_hit_pct)
  let ctxPct = num(usage.context_percent)
  const model = usage.model ?? ''
  if (cacheHit === null) {
    const cr = num(usage.cache_read_tokens), pr = num(usage.prompt_tokens)
    if (cr !== null && pr !== null && pr > 0) cacheHit = (cr / pr) * 100
  }
  if (ctxPct === null && num(usage.context_tokens) !== null && num(usage.context_length) !== null) {
    const u = usage.context_tokens, m = usage.context_length
    if (m > 0) ctxPct = (u / m) * 100
  }
  return { input, output, total, cacheHit, ctxPct, model }
}

function usageFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return null
  const p = ev.payload ?? ev
  return normalize(p.usage ?? p)
}

function eventSid(ev) {
  return ev?.session_id ?? ev?.sessionId ?? null
}

function focusedKey() {
  return host.state.focusedStoredSessionId?.get?.() ?? host.state.focusedSessionId?.get?.() ?? null
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const turnState = atom({
  sid: null,
  cumTotal: null,
  cumIn: null,
  cumOut: null,
  liveTotal: null,    // THIS turn, counting up while running
  liveIn: null,
  liveOut: null,
  lastDelta: null,    // previous turn (finalized at message.complete)
  lastDeltaIn: null,
  lastDeltaOut: null,
  cacheHit: null,
  ctxPct: null,
  model: '',
})

// sid -> { input, output, total, cacheHit, ctxPct, model, finalizedDelta, ... }
const prevBySession = new Map()
// sid -> cumulative snapshot captured at message.start (turn baseline)
const turnBase = new Map()
// sids with no known baseline (fresh session or post-reload cold start):
// their FIRST session.usage ticker becomes the baseline instead of 0.
const pendingBaseline = new Set()

function ingest(sid, snap, finalTurn) {
  if (!sid || !snap || snap.total === null) return
  // Cold start: first ticker snapshot becomes the turn baseline, so "turn"
  // counts up from here rather than mirroring "total".
  if (pendingBaseline.has(sid)) {
    turnBase.set(sid, { input: snap.input ?? 0, output: snap.output ?? 0, total: snap.total })
    pendingBaseline.delete(sid)
  }
  const prev = prevBySession.get(sid)
  let finDelta = prev ? prev.finalizedDelta : null
  let finIn = prev ? prev.finalizedIn : null
  let finOut = prev ? prev.finalizedOut : null

  if (finalTurn) {
    const base = turnBase.get(sid) ?? prev
    if (base && snap.total >= base.total) {
      finDelta = snap.total - base.total
      finIn = (snap.input ?? 0) - (base.input ?? 0)
      finOut = (snap.output ?? 0) - (base.output ?? 0)
    }
    turnBase.delete(sid)
  }

  const entry = {
    input: snap.input ?? 0,
    output: snap.output ?? 0,
    total: snap.total,
    cacheHit: snap.cacheHit,
    ctxPct: snap.ctxPct,
    model: snap.model || (prev?.model || ''),
    finalizedDelta: finDelta,
    finalizedIn: finIn,
    finalizedOut: finOut,
  }
  prevBySession.set(sid, entry)
  if (prevBySession.size > 64) prevBySession.clear()

  if (sid === focusedKey()) {
    const cur = turnState.get()
    const base = turnBase.get(sid)
    turnState.set({
      sid,
      cumTotal: snap.total,
      cumIn: snap.input ?? null,
      cumOut: snap.output ?? null,
      liveTotal: base ? Math.max(0, snap.total - base.total) : null,
      liveIn: base ? Math.max(0, (snap.input ?? 0) - base.input) : null,
      liveOut: base ? Math.max(0, (snap.output ?? 0) - base.output) : null,
      lastDelta: finDelta,
      lastDeltaIn: finIn,
      lastDeltaOut: finOut,
      cacheHit: snap.cacheHit,
      ctxPct: snap.ctxPct,
      model: snap.model || cur.model || '',
    })
  }
}

function onMessageStart(ev) {
  const sid = eventSid(ev)
  if (!sid) return
  const prev = prevBySession.get(sid)
  const ts = turnState.get()
  if (prev) {
    turnBase.set(sid, { input: prev.input, output: prev.output, total: prev.total })
    pendingBaseline.delete(sid)
  } else if (sid === ts.sid && ts.cumTotal !== null) {
    turnBase.set(sid, { input: ts.cumIn ?? 0, output: ts.cumOut ?? 0, total: ts.cumTotal })
    pendingBaseline.delete(sid)
  } else {
    // No known baseline: don't fall back to 0 — the first ticker snapshot
    // becomes the baseline instead.
    pendingBaseline.add(sid)
  }
  if (sid === focusedKey()) {
    const cur = turnState.get()
    turnState.set({ ...cur, liveTotal: 0, liveIn: 0, liveOut: 0 })
  }
}

function onMessageComplete(ev) {
  const sid = eventSid(ev)
  const snap = usageFromEvent(ev)
  if (snap && snap.total !== null) {
    ingest(sid, snap, true)
  } else {
    // complete may carry no usage — finalize from the last ticker snapshot
    // (the diff still uses the message.start base).
    const prev = prevBySession.get(sid)
    if (prev) {
      ingest(sid, { total: prev.total, input: prev.input, output: prev.output, cacheHit: prev.cacheHit, ctxPct: prev.ctxPct, model: prev.model }, true)
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
function TokenStat() {
  // Reactive translator: re-renders on a locale switch AND on a late bundle
  // registration. `ctx.i18n.t` would sample the locale but never re-render.
  const t = usePluginI18n('tokstat')
  const ts = useValue(turnState)
  const focusedRt = useValue(host.state.focusedSessionId)
  const focusedSt = useValue(host.state.focusedStoredSessionId)

  useEffect(() => {
    const offU = host.onEvent('session.usage', (ev) => {
      const snap = usageFromEvent(ev)
      if (snap) ingest(eventSid(ev), snap, false)
    })
    const offS = host.onEvent('message.start', onMessageStart)
    const offC = host.onEvent('message.complete', onMessageComplete)
    return () => { offU?.(); offS?.(); offC?.() }
  }, [])

  // Republish on focus change from the per-session map (no RPC in every build).
  const focusKey = focusedSt ?? focusedRt ?? null
  useEffect(() => {
    if (!focusKey) return
    const prev = prevBySession.get(focusKey)
    if (prev) {
      turnState.set({
        sid: focusKey,
        cumTotal: prev.total,
        cumIn: prev.input || null,
        cumOut: prev.output || null,
        liveTotal: null, liveIn: null, liveOut: null,
        lastDelta: prev.finalizedDelta,
        lastDeltaIn: prev.finalizedIn,
        lastDeltaOut: prev.finalizedOut,
        cacheHit: prev.cacheHit,
        ctxPct: prev.ctxPct,
        model: prev.model,
      })
    }
  }, [focusKey])

  const active = (ts.sid === focusedSt || ts.sid === focusedRt) && ts.cumTotal !== null

  // ── Label ──  Total · Turn(live) · Last · context% · cache%
  let label = `${t('label.total')} —`
  if (active) {
    const parts = [`${t('label.total')} ${fmtCompact(ts.cumTotal)}`]
    if (ts.liveTotal !== null) parts.push(`${t('label.turn')} ${fmtCompact(ts.liveTotal)}`)
    else if (ts.lastDelta !== null && ts.lastDelta > 0) parts.push(`${t('label.last')} ${fmtCompact(ts.lastDelta)}`)
    if (ts.ctxPct !== null) parts.push(`${t('label.ctx')} ${Math.round(ts.ctxPct)}%`)
    if (ts.cacheHit !== null) parts.push(`${t('label.cache')} ${Math.round(ts.cacheHit)}%`)
    label = parts.join(' · ')
  }

  // ── Tooltip ──
  let title
  if (active) {
    title = [
      t('tip.total', fmtExact(ts.cumTotal), fmtExact(ts.cumIn), fmtExact(ts.cumOut)),
      ts.liveTotal !== null
        ? t('tip.turn', fmtExact(ts.liveTotal), fmtExact(ts.liveIn), fmtExact(ts.liveOut))
        : null,
      ts.lastDelta !== null
        ? t('tip.last', fmtExact(ts.lastDelta), fmtExact(ts.lastDeltaIn), fmtExact(ts.lastDeltaOut))
        : null,
      ts.cacheHit !== null ? t('tip.cache', Math.round(ts.cacheHit)) : null,
      ts.ctxPct !== null ? t('tip.ctx', Math.round(ts.ctxPct)) : null,
      ts.model ? t('tip.model', ts.model) : null,
      t('tip.legend'),
    ].filter(l => l !== null).join('\n')
  } else {
    title = t('tip.idle')
  }

  return jsx('span', {
    className: 'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
    title,
    'aria-label': title,
    children: label,
  })
}

const plugin = {
  id: 'tokstat',
  name: 'Token Stat',
  description: 'Session token usage in the Hermes Desktop status bar: cumulative total, live per-turn counter, last turn, context and cache — English and Chinese.',
  register(ctx) {
    ctx.i18n.register(STRINGS)
    ctx.register({
      id: 'tokstat',
      area: 'statusBar.right',
      order: 135,
      render: () => jsx(TokenStat, {}),
    })
  },
}

export default plugin
