// ─────────────────────────────────────────────────────────────────────────────
// Testudo HTTP client.
//
// Requests look like one person's browser: one User-Agent for the whole run
// (rotating it per request from a single IP is itself a bot signal), cookies
// kept between requests, and the headers a browser sends for a page load vs.
// the XHR Testudo's own "show sections" button makes.
//
// Politeness over persistence: a 403/429/503 is treated as "slow down",
// honouring Retry-After, and the caller's circuit breaker ends the run after a
// few consecutive failures rather than pushing through.
// ─────────────────────────────────────────────────────────────────────────────

import { sleep } from './pacer.mjs'

export const BASE = 'https://app.testudo.umd.edu'

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
]

const SLOW_DOWN = new Set([403, 429, 503])

export class TestudoClient {
  constructor({ log = console } = {}) {
    this.userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
    this.cookies = new Map()
    this.log = log
    this.requests = 0
  }

  #cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  #storeCookies(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';')
      const eq = pair.indexOf('=')
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  #headers(kind, referer) {
    const h = {
      'User-Agent':      this.userAgent,
      'Accept-Language': 'en-US,en;q=0.9',
    }
    if (kind === 'xhr') {
      Object.assign(h, {
        'Accept':           'text/html, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Sec-Fetch-Dest':   'empty',
        'Sec-Fetch-Mode':   'cors',
        'Sec-Fetch-Site':   'same-origin',
      })
    } else {
      Object.assign(h, {
        'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest':            'document',
        'Sec-Fetch-Mode':            'navigate',
        'Sec-Fetch-Site':            referer ? 'same-origin' : 'none',
        'Sec-Fetch-User':            '?1',
      })
    }
    if (referer) h['Referer'] = referer
    const cookie = this.#cookieHeader()
    if (cookie) h['Cookie'] = cookie
    return h
  }

  /**
   * GET a Testudo path and return its HTML. Throws after `retries` attempts.
   * @param {string} path      e.g. '/soc/202701/CMSC'
   * @param {'page'|'xhr'} kind
   * @param {string} [referer] absolute URL of the page that "led" here
   */
  async get(path, kind = 'page', referer, retries = 3) {
    const url = BASE + path
    let lastError
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        this.requests++
        const res = await fetch(url, {
          headers: this.#headers(kind, referer),
          signal: AbortSignal.timeout(60_000),
        })
        this.#storeCookies(res)
        if (res.ok) return await res.text()

        lastError = new Error(`HTTP ${res.status}`)
        lastError.status = res.status
        if (attempt === retries) break

        let delay
        if (SLOW_DOWN.has(res.status)) {
          const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10)
          delay = retryAfter > 0 ? retryAfter * 1000 : (5 + Math.random() * 10) * 60_000 * attempt
          this.log.warn(`   ⚠️  ${res.status} on ${path} — Testudo asked us to slow down; pausing ${(delay / 60_000).toFixed(1)} min`)
        } else {
          delay = (20 + Math.random() * 40) * 1000 * attempt
          this.log.warn(`   ⚠️  ${res.status} on ${path} — retrying in ${(delay / 1000).toFixed(0)}s`)
        }
        await sleep(delay)
      } catch (err) {
        lastError = err
        if (attempt === retries) break
        const delay = (20 + Math.random() * 40) * 1000 * attempt
        this.log.warn(`   ⚠️  ${err.message} on ${path} — retrying in ${(delay / 1000).toFixed(0)}s`)
        await sleep(delay)
      }
    }
    throw lastError
  }
}
