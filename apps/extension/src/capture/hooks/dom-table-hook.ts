/**
 * DOM Table / Grid Extraction
 *
 * Same self-containment constraint as main-world-hooks.ts: this is meant to
 * be run via chrome.scripting.executeScript({ func }), which serializes the
 * function with toString() and re-evaluates it standalone in the page. Every
 * helper it uses must be declared inside the exported function body — no
 * closures over module-level names.
 *
 * Two extraction strategies:
 *  - Plain <table>: read every row directly, nothing missing.
 *  - Virtualized grid (AG-Grid, Tabulator, react-window, etc.): the DOM only
 *    ever contains the currently-visible rows. A single read silently
 *    under-captures. This scrolls the grid's own viewport in steps,
 *    re-reading rows after each step and de-duplicating by a stable row
 *    key, until a full pass produces no new rows.
 */

export interface DomExtractionResult {
  sourceUrl: string;
  strategy: 'table' | 'virtualized-grid';
  headers: string[];
  rows: string[][];
  totalRowsSeen: number;
  /**
   * True when the grid advertises more rows (via aria-rowcount) than the
   * scroll-and-accumulate loop actually collected. Some virtualized grids
   * don't respond to programmatic scrollTop/scroll/wheel simulation at all
   * (confirmed directly against a live AG-Grid instance — none of the three
   * moved its rendered rows past the initial viewport), so this can happen
   * even when the loop "completes" without error. Never silently report a
   * capture as whole when it isn't — surface this and let the caller decide
   * whether to warn the user or fall back to a manual-scroll-assisted mode.
   */
  incomplete: boolean;
  expectedRowCount?: number;
}

export async function extractDomTable(rootSelector?: string): Promise<DomExtractionResult | null> {
  function cellText(el: Element): string {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function extractPlainTable(table: HTMLTableElement): { headers: string[]; rows: string[][] } {
    let headerCells: Element[] = Array.from(table.querySelectorAll('thead th'));
    let bodyRows: Element[] = Array.from(table.querySelectorAll('tbody tr'));

    if (headerCells.length === 0) {
      const allRows = Array.from(table.querySelectorAll('tr'));
      const first = allRows[0];
      if (first) {
        const thCells = Array.from(first.querySelectorAll('th'));
        if (thCells.length > 0) {
          headerCells = thCells;
          bodyRows = allRows.slice(1);
        }
      }
    }
    if (bodyRows.length === 0) {
      bodyRows = Array.from(table.querySelectorAll('tr')).filter(
        tr => tr.querySelectorAll('td').length > 0
      );
    }
    // Real-world markup includes genuinely empty rows (e.g. MediaWiki emits
    // <tr class="mw-empty-elt"></tr> as a rendering artifact) — drop any row
    // with zero cells regardless of which branch produced bodyRows.
    bodyRows = bodyRows.filter(tr => tr.querySelectorAll('td, th').length > 0);

    const headers =
      headerCells.length > 0
        ? headerCells.map(cellText)
        : (() => {
            const width = bodyRows[0] ? bodyRows[0].querySelectorAll('td, th').length : 0;
            return Array.from({ length: width }, (_, i) => `column_${i + 1}`);
          })();

    const rows = bodyRows.map(tr => Array.from(tr.querySelectorAll('td, th')).map(cellText));

    return { headers, rows };
  }

  function findGridRoot(): Element | null {
    const selectors = [
      '.ag-root-wrapper', // AG-Grid
      '.tabulator', // Tabulator
      '[role="grid"]',
      '[role="treegrid"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findScrollViewport(root: Element): Element {
    // Grid libraries rename their internal viewport class across versions
    // (confirmed directly against a live ag-grid.com demo: it uses
    // "ag-grid-viewport", not the older "ag-body-viewport" name a hardcoded
    // selector list would have chased). Asking "what actually overflows" is
    // more durable than chasing classnames — prefer the smallest (most
    // specific) scrollable element that still contains row content, since
    // an outer wrapper can also technically qualify as scrollable without
    // being the element that responds to programmatic scrollTop changes.
    const all = Array.from(root.querySelectorAll<HTMLElement>('*'));
    const scrollable = all
      .filter(el => el.scrollHeight > el.clientHeight + 20 && el.querySelector('[role="row"], [role="gridcell"]'))
      .sort((a, b) => a.clientHeight - b.clientHeight);
    return scrollable[0] || root;
  }

  function isHeaderRow(el: Element): boolean {
    return /header/i.test(el.className);
  }

  function readVisibleRows(root: Element): { key: string; cells: string[] }[] {
    const rowEls = Array.from(root.querySelectorAll('[role="row"]')).filter(
      el => !isHeaderRow(el) && el.querySelector('[role="gridcell"], [role="cell"]')
    );

    const rows: { key: string; cells: string[] }[] = [];
    for (const rowEl of rowEls) {
      const cellEls = Array.from(rowEl.querySelectorAll('[role="gridcell"], [role="cell"]'));
      if (cellEls.length === 0) continue;
      const cells = cellEls.map(cellText);
      // Stable dedup key: prefer a row-index/data-index attribute if the
      // grid exposes one (AG-Grid sets row-index; react-window/virtuoso
      // variants set data-index), else fall back to cell content — imperfect
      // for tables with duplicate rows, but scroll order still avoids
      // double-counting the common case.
      const key =
        rowEl.getAttribute('row-index') ||
        rowEl.getAttribute('data-index') ||
        rowEl.getAttribute('aria-rowindex') ||
        cells.join('');
      rows.push({ key, cells });
    }
    return rows;
  }

  function readHeaders(root: Element): string[] {
    const headerCells = Array.from(
      root.querySelectorAll('[role="columnheader"]')
    );
    return headerCells.map(cellText).filter(Boolean);
  }

  function readExpectedRowCount(root: Element): number | undefined {
    // Many ARIA grids advertise their true row count even while virtualized
    // (AG-Grid sets aria-rowcount on the grid container, including header
    // rows in the count). This is the only reliable way to detect an
    // incomplete capture — the accumulation loop finishing its stability
    // check proves nothing on its own if the grid never actually re-renders
    // in response to programmatic scroll.
    const el = root.hasAttribute('aria-rowcount') ? root : root.querySelector('[aria-rowcount]');
    const raw = el?.getAttribute('aria-rowcount');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }

  async function extractVirtualizedGrid(
    root: Element
  ): Promise<{ headers: string[]; rows: string[][]; expectedRowCount?: number }> {
    const viewport = findScrollViewport(root);
    const originalScrollTop = viewport.scrollTop;
    try {
      const collected = new Map<string, string[]>();
      const maxIterations = 200;
      let stableIterations = 0;

      for (let i = 0; i < maxIterations && stableIterations < 3; i++) {
        const before = collected.size;
        for (const { key, cells } of readVisibleRows(root)) {
          if (!collected.has(key)) collected.set(key, cells);
        }
        stableIterations = collected.size > before ? 0 : stableIterations + 1;

        viewport.scrollTop = viewport.scrollTop + viewport.clientHeight * 0.85;
        await new Promise(resolve => setTimeout(resolve, 120));
      }

      // Final read after the loop's last scroll, in case it landed on new rows
      for (const { key, cells } of readVisibleRows(root)) {
        if (!collected.has(key)) collected.set(key, cells);
      }

      const headers = readHeaders(root);
      return { headers, rows: Array.from(collected.values()), expectedRowCount: readExpectedRowCount(root) };
    } finally {
      viewport.scrollTop = originalScrollTop;
    }
  }

  const explicitRoot = rootSelector ? document.querySelector(rootSelector) : null;
  const gridRoot = explicitRoot || findGridRoot();

  if (gridRoot && !(gridRoot instanceof HTMLTableElement)) {
    const { headers, rows, expectedRowCount } = await extractVirtualizedGrid(gridRoot);
    // aria-rowcount conventionally includes header rows; allow a small
    // margin rather than flagging "incomplete" over a header-row miscount.
    const incomplete = expectedRowCount !== undefined && rows.length < expectedRowCount - 3;
    return {
      sourceUrl: window.location.href,
      strategy: 'virtualized-grid',
      headers,
      rows,
      totalRowsSeen: rows.length,
      incomplete,
      expectedRowCount,
    };
  }

  const table = (explicitRoot as HTMLTableElement) || document.querySelector('table');
  if (!table) return null;
  const { headers, rows } = extractPlainTable(table);
  return {
    sourceUrl: window.location.href,
    strategy: 'table',
    incomplete: false,
    headers,
    rows,
    totalRowsSeen: rows.length,
  };
}
