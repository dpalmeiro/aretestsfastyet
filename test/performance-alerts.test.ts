import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../performance-alerts.js', import.meta.url), 'utf8'), context);
const mapping = (repository: string, job_label: string, bug_ids: number[], fixed_bug_ids: number[]) => ({
    schema_version: 3, sheriffing_enabled: false, repository, job_label, bug_ids, fixed_bug_ids, regression_bug_ids: bug_ids,
    bug_count: bug_ids.length, fixed_bug_count: fixed_bug_ids.length,
    window_start: '2025-10-01', generated_at: '2026-10-01',
});

test('bug counts deduplicate repeated runs, shared bugs and aggregate rows', () => {
    const index = context.indexPerformanceAlerts([
        mapping('autoland', 'pdfpaint-1', [10, 11], [10]),
        mapping('autoland', 'pdfpaint-2', [11, 12], [12]),
        mapping('mozilla-central', 'pdfpaint-1', [20], []),
    ]);
    const counts = context.countPerformanceAlerts([
        { project: 'autoland', label: 'pdfpaint-1' },
        { project: 'autoland', label: 'pdfpaint-1' },
        { project: 'autoland', label: 'pdfpaint-2' },
    ], index);
    assert.equal(counts.total, 3);
    assert.equal(counts.fixed, 2);
    assert.equal(counts.mapped, 2);
    assert.equal(counts.configurations, 2);
});

test('a known zero differs from an unmapped job or repository', () => {
    const index = context.indexPerformanceAlerts([mapping('autoland', 'known', [], [])]);
    assert.equal(context.countPerformanceAlerts([{project: 'autoland', label: 'known'}], index).mapped, 1);
    assert.equal(context.countPerformanceAlerts([{project: 'try', label: 'known'}], index).mapped, 0);
    const partial = context.countPerformanceAlerts([
        {project: 'autoland', label: 'known'}, {project: 'autoland', label: 'unknown'},
    ], index);
    assert.equal(partial.mapped, 1);
    assert.equal(partial.configurations, 2);
});

test('rejects stale schemas and inconsistent fixed-bug counts', () => {
    assert.throws(() => context.indexPerformanceAlerts([{signature_id: 42, bug_count: 10}]));
    assert.throws(() => context.indexPerformanceAlerts([mapping('autoland', 'bad', [1], [2])]));
});

test('dashboard loads counts without blocking runtime data and deduplicates aggregate totals', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(readFileSync(new URL('../performance-tests.html', import.meta.url), 'utf8'), {
        url: 'https://example.com/performance-tests.html', runScripts: 'outside-only',
    });
    const w = dom.window;
    try {
        const labels = ['test-linux/opt-talos-pdfpaint-1', 'test-linux/opt-talos-pdfpaint-2'];
        const day = Date.parse('2026-09-30T00:00:00Z');
        w.fetchFromCI = async (_: string, file: string) => Response.json(file === 'index.json'
            ? { dates: ['2026-09-30'] } : {
                metadata: { taskCount: 3 },
                tables: { labels, projects: ['autoland'], taskQueueIds: ['hardware/test', 'hardware/test-other'] },
                taskGroupInfo: { projectIds: [0] },
                tasks: { scheduled: [day, 0, 0], started: [0, 0, 0], resolved: [1000, 2000, 3000],
                    taskIds: ['a.0', 'b.0', 'c.0'], labelIds: [0, 1, 0], taskGroupIdIds: [0, 0, 0], taskQueueIdIds: [0, 0, 1] },
            });
        let deliver: (result: unknown) => void = () => {};
        const pending = new Promise(resolve => { deliver = resolve; });
        w.fetch = async url => Response.json(String(url).startsWith('./')
            ? { results_url: 'https://alerts.example/results', resolutions_results_url: 'https://resolutions.example/results' } : String(url).includes('resolutions.example')
                ? { query_result: { data: { rows: [{id: 1, resolution: 'FIXED'}, {id: 2, resolution: 'DUPLICATE'}, {id: 3, resolution: ''}] } } } : await pending);
        w.eval(['task-timeline-profiler.js', 'performance-alerts.js', 'performance-tests.js']
            .map(file => readFileSync(new URL('../' + file, import.meta.url), 'utf8')).join('\n'));
        await new Promise(resolve => setTimeout(resolve, 0));
        const initialPool = w.document.getElementById('pool') as HTMLSelectElement;
        assert.equal(initialPool.value, 'all');
        assert.equal(w.location.search, '');
        assert.equal(w.document.getElementById('summary-runs')!.textContent, '3');
        initialPool.value = 'hardware/test';
        initialPool.dispatchEvent(new w.Event('change'));
        assert.equal(w.document.querySelector<HTMLTableRowElement>('tbody tr')!.cells[3]!.textContent, '…');
        assert.equal(w.document.getElementById('summary-runs')!.textContent, '2');
        deliver({ query_result: { data: { rows: [
            { ...mapping('autoland', labels[0]!, [1, 2], [1]), sheriffing_enabled: true },
            mapping('autoland', labels[1]!, [2, 3], [3]),
        ] } } });
        await new Promise(resolve => setTimeout(resolve, 0));
        const total = w.document.querySelector<HTMLTableRowElement>('tbody tr')!;
        assert.equal(total.cells[3]!.querySelector('.resolution-total')?.textContent, '3');
        const bugsLink = total.cells[3]!.querySelector<HTMLAnchorElement>('a')!;
        assert.equal(new URL(bugsLink.href).searchParams.get('bug_id'), '1');
        assert.equal(bugsLink.target, '_blank');
        assert.match(total.cells[3]!.querySelector('.resolution-tooltip')!.textContent!, /Fixed: 1/);
        assert.match(total.cells[3]!.querySelector('.resolution-tooltip')!.textContent!, /Duplicate: 1/);
        assert.match(total.cells[3]!.querySelector('.resolution-tooltip')!.textContent!, /Open: 1/);
        assert.equal(total.cells[3]!.querySelectorAll('.resolution-bar span').length, 3);
        assert.equal(w.document.getElementById('bug-panel'), null);
        const search = w.document.getElementById('test-search') as HTMLInputElement;
        search.value = 'PDFPAINT-1';
        search.dispatchEvent(new w.Event('input'));
        const filteredTotal = w.document.querySelector<HTMLTableRowElement>('tbody tr')!;
        assert.equal(filteredTotal.cells[1]!.textContent, '33.3%');
        assert.equal(filteredTotal.cells[2]!.textContent, '1');
        assert.equal(filteredTotal.cells[3]!.querySelector('.resolution-total')?.textContent, '2');
        assert.equal(w.document.getElementById('summary-configs')!.textContent, '1');
        search.value = '';
        search.dispatchEvent(new w.Event('input'));
        const toggle = w.document.querySelector<HTMLButtonElement>('.group-toggle')!;
        assert.equal(toggle.textContent, '▸ talos-pdfpaint');
        toggle.click();
        assert.equal(w.document.querySelectorAll('.test-child').length, 2);
        assert.equal(w.document.querySelector('.test-child .pool-name')!.textContent, labels[1]);
        assert.equal(w.document.querySelector('.group-toggle')!.getAttribute('aria-expanded'), 'true');
        w.document.querySelector<HTMLButtonElement>('.group-toggle')!.click();
        assert.equal(w.document.querySelectorAll('.test-child').length, 0);
        const rows = w.document.querySelectorAll<HTMLTableRowElement>('tbody tr');
        assert.equal(rows.length, 2);
        assert.equal(rows[1]!.cells[3]!.querySelector('.resolution-total')?.textContent, '3');
        const pool = w.document.getElementById('pool') as HTMLSelectElement;
        const previousPool = pool.value;
        pool.value = 'all';
        pool.dispatchEvent(new w.Event('change'));
        assert.equal(pool.disabled, false);
        assert.equal(w.document.getElementById('summary-runs')!.textContent, '3');
        const combined = w.document.querySelectorAll<HTMLTableRowElement>('tbody tr');
        assert.equal(combined.length, 2);
        assert.equal(combined[0]!.cells[2]!.textContent, '3');
        assert.equal(combined[0]!.cells[3]!.querySelector('.resolution-total')?.textContent, '3');
        assert.equal(new URL(w.location.href).searchParams.get('pool'), 'all');
        pool.value = previousPool;
        pool.dispatchEvent(new w.Event('change'));
        assert.equal(w.document.getElementById('summary-runs')!.textContent, '2');
        assert.equal((w.document.getElementById('pool') as HTMLSelectElement).disabled, false);

    } finally { w.close(); }
});


test('regression filtering is per job even when a bug covers improvements on another job', () => {
    const index = context.indexPerformanceAlerts([
        {...mapping('autoland', 'a', [1, 2], []), regression_bug_ids: [1]},
        {...mapping('autoland', 'b', [1, 2], []), regression_bug_ids: [2]},
    ]);
    assert.deepEqual(Array.from(context.countPerformanceAlerts([{project:'autoland',label:'a'}], index).bugIds), [1]);
    assert.deepEqual(Array.from(context.countPerformanceAlerts([{project:'autoland',label:'b'}], index).bugIds), [2]);
});
