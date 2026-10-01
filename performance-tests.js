// Uses the same compact daily task artifacts as workers.html.
'use strict';

function performanceSuite(label) {
    if (!/^(?:test-|perftest-|mozperftest-)/.test(label)) return null;
    if (/(?:^|-)browsertime-/.test(label)) return 'Browsertime';
    if (/(?:^|-)raptor-/.test(label)) return 'Raptor';
    if (/(?:^|-)talos-/.test(label)) return 'Talos';
    if (/(?:^|-)awsy(?:-|$)/.test(label)) return 'AWSY';
    if (/(?:^|-)(?:moz)?perftest(?:-|$)/.test(label)) return 'mozperftest';
    if (/-mochitest-browser-speedometer\d*(?:-|$)/.test(label)) return 'Mochitest Speedometer';
    return null;
}

function decodePerformanceTasks(data, date) {
    const { tasks, tables, taskGroupInfo, workerInfo, metadata } = data;
    const dayStart = Date.parse(date + 'T00:00:00Z');
    const dayEnd = dayStart + 86400000;
    const rows = [];
    let scheduled = 0;
    const seen = new Set();
    for (let i = 0; i < metadata.taskCount; i++) {
        scheduled += tasks.scheduled[i];
        const label = tables.labels[tasks.labelIds[i]] || '';
        const suite = performanceSuite(label);
        if (!suite || tasks.started[i] == null || tasks.resolved[i] == null) continue;
        const start = scheduled + tasks.started[i];
        const end = scheduled + tasks.resolved[i];
        const milliseconds = Math.min(end, dayEnd) - Math.max(start, dayStart);
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) continue;
        const run = tasks.taskIds[i];
        if (seen.has(run)) continue;
        seen.add(run);
        const group = tasks.taskGroupIdIds[i];
        const projectId = group == null ? null : taskGroupInfo.projectIds[group];
        // taskQueueIds are the actual provisioner/worker-type pools, as in workers.html.
        const pool = tables.taskQueueIds[tasks.taskQueueIdIds[i]] || 'unknown';
        const resolution = tables.resolutions?.[tasks.resolutionIds?.[i]] || '';
        const [state, reason = state] = resolution.split(' - ');
        const runMatch = run.match(/^(.*)\.(\d+)$/);
        const worker = tasks.workerIdIds?.[i];
        const profileTask = {
            label, task_queue_id: pool, task_id: runMatch ? runMatch[1] : run,
            run_id: runMatch ? runMatch[2] : '0',
            _scheduledMs: scheduled, _startedMs: start, _resolvedMs: end,
            state, reason_resolved: reason,
            priority: tables.priorities?.[tasks.priorityIds?.[i]] || '',
            worker_id: worker == null ? '' : tables.workerIds?.[worker] || '',
            worker_group: worker == null ? '' : tables.workerGroups?.[workerInfo?.workerGroupIds[worker]] || '',
            task_group_id: group == null ? '' : tables.taskGroupIds?.[group] || '',
            project: projectId == null ? 'unknown' : tables.projects[projectId] || 'unknown',
        };
        rows.push({ label, suite, pool, milliseconds, profileTask,
            start: Math.max(start, dayStart), end: Math.min(end, dayEnd),
            project: projectId == null ? 'unknown' : tables.projects[projectId] || 'unknown' });
    }
    return rows;
}

function summarizePerformance(rows, key) {
    const groups = new Map();
    for (const row of rows) {
        const name = typeof key === 'function' ? key(row) : row[key];
        const entry = groups.get(name) || { name, milliseconds: 0, runs: 0, intervals: [] };
        entry.milliseconds += row.milliseconds;
        entry.runs++;
        entry.intervals.push(row);
        groups.set(name, entry);
    }
    return [...groups.values()].sort((a, b) => b.milliseconds - a.milliseconds);
}

const PERFORMANCE_AGGREGATES = [
    'opt-talos-pdfpaint',
    'opt-browsertime-tp6',
    'opt-talos-g1',
    'opt-talos-damp',
    'opt-browsertime-responsiveness',
    'opt-talos-tp5o',
    'browsertime-benchmark-firefox-speedometer3',
];

const TALOS_AGGREGATES = [
    'svgr', 'g3', 'g4', 'g5', 'bcv', 'chrome', 'other', 'dromaeojs',
    'perf-reftest', 'webgl', 'sessionrestore-many-windows', 'realworld-webextensions', 'xperf',
];
const BROWSERTIME_AGGREGATES = new Set([
    'webcodecs', 'indexeddb', 'network-bench', 'video-playback-latency',
    'video-playback-latency-mobile', 'youtube-playback', 'youtube-playback-mobile',
    'media-playback', 'power', 'speculation-rules', 'speculative', 'hev3-connection',
    'hev3-connection-m', 'trr-performance', 'trr-performance-m', 'upload',
    'nav-bench', 'first-install', 'media-seek',
].map(name => 'browsertime-' + name));
const BENCHMARK_AGGREGATES = [
    'speedometer-experimental', 'speedometer3', 'speedometer2', 'jetstream3',
    'motionmark', 'matrix-react-bench', 'stylebench', 'unity-webgl', 'webaudio',
    'media-capabilities', 'twitch-animation', 'assorted-dom',
];
const PERFTEST_AGGREGATES = [
    'ml-llama-summarizer-perf', 'ml-llama-smollm2-smoke', 'ml-perf-semantic',
    'ml-perf-suggest', 'ml-perf-autofill', 'ml-perf-smart-tab', 'ml-multi-perf',
    'ml-perf', 'tr8ns-perf', 'perftest-accessibility', 'perftest-places',
    'service-worker', 'speech-recognition-perf', 'linkpreview-perf',
    'semantichistory-perf', 'formautofill-ml-perf', 'mlsuggest-perf',
    'smarttabgrouping-perf', 'smartwindow-perf', 'busy-trr', 'browsertime-sample',
];
const hasPrefix = (value, prefix) => value === prefix || value.startsWith(prefix + '-');

function performanceAggregate(label) {
    // Keep the original explicitly requested substring rules unchanged.
    const existing = PERFORMANCE_AGGREGATES.find(pattern => label.includes(pattern));
    if (existing) return `*${existing}*`;
    const test = label.match(/^test-[^/]+\/(opt|debug)-(.+)$/);
    if (test) {
        const [, build, job] = test;
        if (build === 'opt') {
            const talos = TALOS_AGGREGATES.find(name => hasPrefix(job, 'talos-' + name));
            if (talos) return `*opt-talos-${talos}*`;
            if (hasPrefix(job, 'awsy')) return '*opt-awsy*';
        }
        const perf = splitPerfSuite(job);
        if (perf) {
            let family = perf.suite;
            if (family === 'browsertime-benchmark') {
                const benchmark = BENCHMARK_AGGREGATES.find(name => hasPrefix(perf.test, name));
                if (!benchmark) return label;
                family += '-' + benchmark;
            } else if (family === 'browsertime-custom' || family === 'browsertime-regression-tests') {
                // Keep distinct custom/regression workloads, removing only known variants.
                let name = perf.test;
                let previous;
                do {
                    previous = name;
                    for (const variant of ['native-profiling', ...VARIANT_SUFFIXES]) {
                        if (name.endsWith('-' + variant)) name = name.slice(0, -variant.length - 1);
                    }
                } while (name !== previous);
                family += '-' + name;
            } else if (!BROWSERTIME_AGGREGATES.has(family) && !family.startsWith('browsertime-benchmark-')) {
                return label;
            }
            return `${build}-${family} [${perf.app}]`;
        }
    }
    if (/^(?:moz)?perftest-/.test(label)) {
        if (label.startsWith('perftest-android-emulator-')) return 'mozperftest Android emulator startup';
        const startup = label.match(/-startup-(fenix|geckoview|chrome-m|refbrow)-/);
        if (startup) return `mozperftest Android startup [${startup[1]}]`;
        const resource = label.match(/-(?:background|foreground)-resource-(.+)$/);
        if (resource) return `mozperftest Android resources [${resource[1]}]`;
        const family = PERFTEST_AGGREGATES.find(name => label.includes('-' + name + '-') || label.endsWith('-' + name));
        if (family) return 'mozperftest ' + family;
    }
    return label;
}

function performanceGroups(rows, aggregate) {
    return summarizePerformance(rows, row => aggregate ? performanceAggregate(row.label) : row.label);
}

function performanceMarkerSearch(name) {
    return name.startsWith('*') && name.endsWith('*') ? name.slice(1, -1) : name;
}

let performanceRows = [];
let loadVersion = 0;
const expandedPerformanceGroups = new Set();
let performanceSort = { key: 'runtime', descending: true };

// Maximum simultaneous running jobs in each five-minute bucket. Aggregate
// simultaneous starts/ends before sampling so adjacent runs do not form a spike.
function performanceActivity(intervals, dayStart, bucketCount = 288) {
    const events = new Map();
    const dayEnd = dayStart + 86400000;
    for (const interval of intervals) {
        const start = Math.max(dayStart, interval.start);
        const end = Math.min(dayEnd, interval.end);
        if (!(end > start)) continue;
        events.set(start, (events.get(start) || 0) + 1);
        events.set(end, (events.get(end) || 0) - 1);
    }
    const ordered = [...events].sort((a, b) => a[0] - b[0]);
    const buckets = new Array(bucketCount).fill(0);
    const width = 86400000 / bucketCount;
    let running = 0;
    for (let i = 0; i < ordered.length - 1; i++) {
        running += ordered[i][1];
        const first = Math.floor((ordered[i][0] - dayStart) / width);
        const last = Math.ceil((ordered[i + 1][0] - dayStart) / width) - 1;
        for (let bucket = first; bucket <= last && bucket < bucketCount; bucket++) {
            buckets[bucket] = Math.max(buckets[bucket], running);
        }
    }
    return buckets;
}

function performanceActivityGraph(buckets, name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const peak = Math.max(1, ...buckets);
    svg.classList.add('activity-track');
    svg.setAttribute('viewBox', `0 0 ${buckets.length} 36`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${name}: running jobs over 00:00–24:00 UTC, peak ${Math.max(...buckets)}`);
    for (let hour = 0; hour <= 24; hour += 6) {
        const line = document.createElementNS(ns, 'line');
        const x = hour / 24 * buckets.length;
        for (const [key, value] of Object.entries({ x1: x, x2: x, y1: 0, y2: 36 })) line.setAttribute(key, String(value));
        line.setAttribute('stroke', '#ddd');
        svg.appendChild(line);
    }
    buckets.forEach((count, index) => {
        // Transparent full-height hit targets also give useful tooltips for idle periods.
        const group = document.createElementNS(ns, 'g');
        const title = document.createElementNS(ns, 'title');
        const time = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        title.textContent = `${time(index * 5)}–${time((index + 1) * 5)} UTC: peak ${count} running jobs`;
        group.appendChild(title);
        for (const [height, fill] of [[36, 'transparent'], [count / peak * 35, 'rgba(0,96,223,0.6)']]) {
            const rect = document.createElementNS(ns, 'rect');
            for (const [key, value] of Object.entries({ x: index, y: 36 - height, width: 1, height, fill })) rect.setAttribute(key, String(value));
            group.appendChild(rect);
        }
        svg.appendChild(group);
    });
    return svg;
}

function performanceProfilerSeries(rows, dayStart) {
    const changes = new Map([[dayStart, 0], [dayStart + 86400000, 0]]);
    for (const row of rows) {
        changes.set(row.start, (changes.get(row.start) || 0) + 1);
        changes.set(row.end, (changes.get(row.end) || 0) - 1);
    }
    let running = 0;
    return [...changes].sort((a, b) => a[0] - b[0]).map(([time, delta]) => {
        running += delta;
        return { time, total: running, running, expired: 0 };
    });
}

function performanceGroupName(name) {
    return name.replace(/\*/g, '').replace(/^test-[^/]+\//, '').replace(/^opt-/, '');
}

function sortPerformanceGroups(groups, dayStart, children = false) {
    const key = performanceSort.key;
    const value = group => {
        if (key === 'name') return children ? group.name : performanceGroupName(group.name);
        if (key === 'runtime') return group.milliseconds;
        if (key === 'runs') return group.runs;
        if (key === 'peak') return Math.max(...performanceActivity(group.intervals, dayStart));
        if (performanceAlertsState.status !== 'ready') return null;
        const counts = countPerformanceAlerts(group.intervals, performanceAlertsState.index);
        return counts.mapped ? counts[key === 'alerts' ? 'total' : 'fixed'] : null;
    };
    return groups.map(group => ({ group, value: value(group) })).sort((a, b) => {
        if (a.value === null || b.value === null) {
            if (a.value !== b.value) return a.value === null ? 1 : -1;
        } else {
            const comparison = typeof a.value === 'string' ? a.value.localeCompare(b.value) : a.value - b.value;
            if (comparison) return performanceSort.descending ? -comparison : comparison;
        }
        return a.group.name.localeCompare(b.group.name);
    }).map(entry => entry.group);
}

function performanceTable(groups, heading, total) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pool-table-wrapper';
    const table = document.createElement('table');
    table.className = 'pool-table';
    const head = table.createTHead().insertRow();
    for (const [label, key] of [[heading, 'name'], ['Runtime share', 'runtime'], ['Runs', 'runs'], ['Resolutions', 'alerts'], ['Peak running', 'peak'], ['Activity (UTC)', null]]) {
        const th = document.createElement('th');
        th.scope = 'col';
        if (label !== heading && label !== 'Activity (UTC)') th.className = 'num';
        if (label === 'Activity (UTC)') th.title = 'Peak running jobs in five-minute buckets; each row is scaled to its own peak.';
        if (key === 'alerts') th.title = 'Number of distinct bugs linked to regression alerts created for this test in the past 365 days.';

        if (key) {
            th.setAttribute('aria-sort', performanceSort.key === key ? (performanceSort.descending ? 'descending' : 'ascending') : 'none');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sort-button';
            button.dataset.sort = key;
            button.textContent = label + (performanceSort.key === key ? (performanceSort.descending ? ' ▾' : ' ▴') : '');
            button.addEventListener('click', () => {
                performanceSort = { key, descending: performanceSort.key === key ? !performanceSort.descending : key !== 'name' };
                renderPerformance();
                document.querySelector(`[data-sort="${key}"]`)?.focus({ preventScroll: true });
            });
            th.appendChild(button);
        } else th.textContent = label;
        head.appendChild(th);
    }
    const body = table.createTBody();
    const totalRuns = groups.reduce((sum, group) => sum + group.runs, 0);
    const dayStart = Date.parse(document.getElementById('date').value + 'T00:00:00Z');
    const entries = [{ name: 'All configurations', milliseconds: groups.reduce((sum, group) => sum + group.milliseconds, 0), runs: totalRuns, intervals: groups.flatMap(group => group.intervals) }];
    for (const group of sortPerformanceGroups(groups, dayStart)) {
        entries.push({ ...group, key: group.name, name: performanceGroupName(group.name), parent: true });
        if (expandedPerformanceGroups.has(group.name)) {
            entries.push(...sortPerformanceGroups(performanceGroups(group.intervals, false), dayStart, true).map(child => ({ ...child, child: true })));
        }
    }
    for (const [index, group] of entries.entries()) {
        const row = body.insertRow();
        if (index === 0) row.className = 'all-tasks-row';
        const name = row.insertCell();
        name.textContent = name.title = group.name;
        name.className = 'pool-name';
        if (group.child) row.classList.add('test-child');
        if (group.parent) {
            row.classList.add('test-group');
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'group-toggle';
            const expanded = expandedPerformanceGroups.has(group.key);
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.textContent = `${expanded ? '▾' : '▸'} ${group.name}`;
            name.replaceChildren(toggle);
            const expand = () => {
                if (expandedPerformanceGroups.has(group.key)) expandedPerformanceGroups.delete(group.key);
                else expandedPerformanceGroups.add(group.key);
                renderPerformance();
                const replacement = [...document.querySelectorAll('.group-toggle')]
                    .find(button => button.parentElement.title === group.name);
                replacement?.focus({ preventScroll: true });
            };
            toggle.addEventListener('click', expand);
            row.addEventListener('click', event => {
                if (!event.target.closest('button, a')) expand();
            });
        }

        const share = total > 0 ? 100 * group.milliseconds / total : 0;
        const hours = (group.milliseconds / 3600000).toLocaleString(undefined,
            { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const runtime = row.insertCell();
        runtime.className = 'runtime-cell';
        runtime.title = `${hours} worker-hours`;
        const runtimeChart = document.createElement('div');
        runtimeChart.className = 'runtime-chart';
        runtimeChart.setAttribute('aria-label', `${share.toFixed(1)}% of runtime, ${hours} worker-hours`);
        const track = document.createElement('span');
        track.className = 'runtime-track';
        track.setAttribute('aria-hidden', 'true');
        const bar = document.createElement('span');
        bar.className = 'runtime-bar';
        bar.style.width = `${share}%`;
        track.appendChild(bar);
        const percentage = document.createElement('span');
        percentage.className = 'runtime-percentage';
        percentage.textContent = `${share.toFixed(1)}%`;
        runtimeChart.append(track, percentage);
        runtime.appendChild(runtimeChart);
        const runs = row.insertCell();
        runs.className = 'num';
        runs.textContent = group.runs.toLocaleString();
        const totalCell = row.insertCell();
        totalCell.className = 'resolution-cell';
        performanceAlertCells.push({ runs: group.intervals, totalCell });
        const buckets = performanceActivity(group.intervals, dayStart);
        const peak = row.insertCell();
        peak.className = 'num';
        peak.textContent = String(Math.max(...buckets));
        const activity = row.insertCell();
        activity.className = 'activity-cell';
        const container = document.createElement('div');
        container.className = 'activity-container';
        const graph = document.createElement('div');
        graph.className = 'activity-graph';
        container.appendChild(graph);
        activity.appendChild(container);
        graph.appendChild(performanceActivityGraph(buckets, group.name));
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'profiler-btn';
        button.textContent = 'Profiler';
        button.title = `Open ${group.name} task timeline in Firefox Profiler`;
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await openTaskTimelineInProfiler(group.intervals.map(row => ({ ...row.profileTask, aggregate: group.name })),
                    `${document.getElementById('pool').value === 'all' ? 'All worker pools' : document.getElementById('pool').value}: ${group.name}`,
                    performanceProfilerSeries(group.intervals, dayStart), dayStart, dayStart + 86400000,
                    [], index > 0 ? performanceMarkerSearch(group.name) : '');
            } catch (error) {
                const element = document.getElementById('error');
                element.textContent = `Unable to open Profiler: ${error.message}`;
                element.style.display = 'block';
            } finally {
                button.disabled = false;
            }
        });
        container.appendChild(button);
    }
    wrapper.appendChild(table);
    updatePerformanceAlertCells();
    return wrapper;
}

function clearPerformanceResults() {
    const results = document.getElementById('results');
    performanceAlertCells = [];
    results.replaceChildren();
    return results;
}

function updatePerformancePools() {
    const select = document.getElementById('pool');
    const previous = select.value || new URLSearchParams(location.search).get('pool');
    const project = document.getElementById('project').value;
    const names = [...new Set(performanceRows.filter(row => !project || row.project === project)
        .map(row => row.pool))].sort();
    select.replaceChildren(new Option('All', 'all'));
    names.forEach(name => select.add(new Option(name, name)));
    select.value = previous === 'all' || names.includes(previous) ? previous : 'all';
    select.disabled = !names.length;
    renderPerformance();
}

function renderPerformance() {
    const project = document.getElementById('project').value;
    const pool = document.getElementById('pool').value;
    const search = document.getElementById('test-search').value.trim();
    const query = search.toLowerCase();
    const poolRows = performanceRows.filter(row => (pool === 'all' || row.pool === pool) && (!project || row.project === project));
    const rows = poolRows.filter(row => (!query || row.label.toLowerCase().includes(query)
            || performanceGroupName(performanceAggregate(row.label)).toLowerCase().includes(query)));
    const results = clearPerformanceResults();
    const url = new URL(location.href);
    url.searchParams.delete('platform');
    url.searchParams.delete('allPools');
    if (search) url.searchParams.set('search', search);
    else url.searchParams.delete('search');
    url.searchParams.delete('aggregate');
    history.replaceState(null, '', url);
    const total = rows.reduce((sum, row) => sum + row.milliseconds, 0);
    const groups = performanceGroups(rows, true);
    document.getElementById('summary-date').textContent = document.getElementById('date').value;
    document.getElementById('summary-configs').textContent = new Set(rows.map(row => row.label)).size.toLocaleString();
    document.getElementById('summary-runs').textContent = rows.length.toLocaleString();
    document.getElementById('summary-hours').textContent = (total / 3600000).toLocaleString(undefined, { maximumFractionDigits: 2 });
    document.getElementById('status').textContent = rows.length ? '' : query ? 'No tests match your search.' : 'No performance-test runs for this date and project.';
    if (!rows.length) return;
    results.appendChild(performanceTable(groups, 'Job configuration', poolRows.reduce((sum, row) => sum + row.milliseconds, 0)));
}

async function loadPerformanceDate() {
    const version = ++loadVersion;
    const date = document.getElementById('date').value;
    const project = document.getElementById('project');
    project.disabled = true;
    document.getElementById('test-search').disabled = true;
    document.getElementById('pool').disabled = true;
    clearPerformanceResults();
    document.querySelectorAll('.summary-stat .value').forEach(value => { value.textContent = '—'; });
    document.getElementById('error').style.display = 'none';
    document.getElementById('status').textContent = `Loading task data for ${date}…`;
    try {
        const response = await fetchFromCI('worker-data', `workers-${date}-tasks.json`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (version !== loadVersion) return;
        performanceRows = decodePerformanceTasks(data, date);
        const previous = project.value;
        project.replaceChildren(new Option('All projects', ''));
        [...new Set(performanceRows.map(row => row.project))].sort()
            .forEach(name => project.add(new Option(name, name)));
        project.value = [...project.options].some(option => option.value === previous) ? previous : '';
        project.disabled = false;
        document.getElementById('test-search').disabled = false;
        updatePerformancePools();
    } catch (error) {
        if (version === loadVersion) showPerformanceError(error);
    }
}

function showPerformanceError(error) {
    document.getElementById('status').textContent = '';
    const element = document.getElementById('error');
    element.textContent = `Unable to load performance-test data: ${error.message}. Reload to retry.`;
    element.style.display = 'block';
}

async function initializePerformance() {
    loadPerformanceAlerts();
    const search = document.getElementById('test-search');
    search.value = new URLSearchParams(location.search).get('search') || '';
    search.addEventListener('input', renderPerformance);
    try {
        const response = await fetchFromCI('worker-data', 'index.json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const index = await response.json();
        const dates = [...new Set(index.dates || [])].sort().reverse();
        if (!dates.length) throw new Error('No dates available');
        const select = document.getElementById('date');
        dates.forEach(date => select.add(new Option(date, date)));
        const requested = new URLSearchParams(location.search).get('date');
        select.value = dates.includes(requested) ? requested : dates[0];
        select.disabled = false;
        select.addEventListener('change', () => {
            const url = new URL(location.href);
            url.searchParams.set('date', select.value);
            history.replaceState(null, '', url);
            loadPerformanceDate();
        });
        document.getElementById('project').addEventListener('change', updatePerformancePools);
        document.getElementById('pool').addEventListener('change', () => {
            const url = new URL(location.href);
            url.searchParams.set('pool', document.getElementById('pool').value);
            history.replaceState(null, '', url);
            renderPerformance();
        });
        await loadPerformanceDate();
    } catch (error) { showPerformanceError(error); }
}

initializePerformance();
