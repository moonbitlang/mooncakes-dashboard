import { useEffect, useMemo, useState } from 'npm:preact/hooks';
import { html, render } from 'npm:htm/preact';
import type { BuildResult, MetaData, Result } from './lib/types.ts';
import { TextLineStream } from '@std/streams/text-line-stream';
import { JsonParseStream } from '@std/json/parse-stream';

type DataMap = {
  [key: string]: {
    metadata: MetaData | null;
    results: BuildResult[];
  };
};

const PLATFORMS = ['mac', 'linux', 'windows'] as const;
const CHANNELS = ['stable', 'nightly', 'pre-release'] as const;
const COMMANDS = ['check', 'build', 'test'] as const;
const BACKENDS = ['wasm', 'wasm-gc', 'js', 'native'] as const;

const ENVIRONMENTS = PLATFORMS.flatMap((platform) => CHANNELS.map((channel) => `${platform}/${channel}` as const));

type Platform = (typeof PLATFORMS)[number];
type Channel = (typeof CHANNELS)[number];
type EnvironmentKey = (typeof ENVIRONMENTS)[number];
type Label = 'regression' | 'warning' | 'inconsistent' | 'ok' | '';
type FilterLabel = 'all' | 'regression' | 'warning' | 'inconsistent' | 'ok';
type CellStatus = 'success' | 'warning' | 'failure' | 'skipped' | 'error';

type RowData = {
  identifier: string;
  results: Record<EnvironmentKey, BuildResult | null>;
  statuses: Record<EnvironmentKey, CellStatus>;
  label: Label;
  reason: string;
  issueCount: number;
};

const STATUS_COLORS: Record<CellStatus, string> = {
  success: '#22c55e',
  warning: '#d97706',
  failure: '#ef4444',
  skipped: '#94a3b8',
  error: '#f97316',
};

const STATUS_LABELS: Record<CellStatus, string> = {
  success: 'S',
  warning: 'W',
  failure: 'F',
  skipped: '-',
  error: 'E',
};

const LABEL_COLORS: Record<Label, string> = {
  regression: '#dc2626',
  warning: '#d97706',
  inconsistent: '#f59e0b',
  ok: '#16a34a',
  '': '#64748b',
};

const LABEL_PRIORITY: Record<Label, number> = {
  regression: 0,
  warning: 1,
  inconsistent: 2,
  ok: 3,
  '': 4,
};

function envKey(platform: Platform, channel: Channel): EnvironmentKey {
  return `${platform}/${channel}`;
}

function createEmptyResults(): Record<EnvironmentKey, BuildResult | null> {
  const results = {} as Record<EnvironmentKey, BuildResult | null>;
  for (const env of ENVIRONMENTS) {
    results[env] = null;
  }
  return results;
}

function createEmptyStatuses(): Record<EnvironmentKey, CellStatus> {
  const statuses = {} as Record<EnvironmentKey, CellStatus>;
  for (const env of ENVIRONMENTS) {
    statuses[env] = 'skipped';
  }
  return statuses;
}

function getIdentifier(source: BuildResult['source']): string {
  if (source.type === 'mooncakes') {
    return `${source.name}@${source.version}`;
  }
  return `${source.url}#${source.rev}`;
}

function getResultStatus(res: Result): CellStatus {
  if (res.status === 'Success') return 'success';
  if (res.status === 'WarningFailure') return 'warning';
  if (res.status === 'Failure') return 'failure';
  return 'skipped';
}

function getOverallStatus(result: BuildResult | null): CellStatus {
  if (!result) return 'skipped';
  if (result.error) return 'error';
  if (!result.cbt) return 'skipped';

  let hasWarning = false;
  for (const command of COMMANDS) {
    for (const backend of BACKENDS) {
      const status = result.cbt[command][backend].status;
      if (status === 'Failure') return 'failure';
      if (status === 'WarningFailure') hasWarning = true;
    }
  }

  return hasWarning ? 'warning' : 'success';
}

function isIssueStatus(status: CellStatus): boolean {
  return status === 'failure' || status === 'warning' || status === 'error';
}

function countResultIssues(result: BuildResult | null): number {
  if (!result) return 0;
  if (result.error) return 1;
  if (!result.cbt) return 0;

  let issueCount = 0;
  for (const command of COMMANDS) {
    for (const backend of BACKENDS) {
      if (isIssueStatus(getResultStatus(result.cbt[command][backend]))) {
        issueCount += 1;
      }
    }
  }

  return issueCount;
}

function classifyRow(statuses: Record<EnvironmentKey, CellStatus>): { label: Label; reason: string } {
  for (const platform of PLATFORMS) {
    const nightly = statuses[envKey(platform, 'nightly')];
    const stable = statuses[envKey(platform, 'stable')];
    if (nightly === 'failure' && stable === 'success') {
      return {
        label: 'regression',
        reason: `${platform}: nightly failed while stable succeeded`,
      };
    }
  }

  for (const platform of PLATFORMS) {
    const nightly = statuses[envKey(platform, 'nightly')];
    const stable = statuses[envKey(platform, 'stable')];
    if (nightly === 'warning' && stable === 'success') {
      return {
        label: 'warning',
        reason: `${platform}: nightly failed due warning checks while stable succeeded`,
      };
    }
  }

  for (const channel of CHANNELS) {
    const states = PLATFORMS.map((platform) => {
      const status = statuses[envKey(platform, channel)];
      return `${platform}:${status}`;
    });
    const unique = new Set(states.map((item) => item.split(':')[1]).filter((status) => status !== 'skipped'));
    if (unique.size > 1) {
      return {
        label: 'inconsistent',
        reason: `${channel} differs across OS (${states.join(', ')})`,
      };
    }
  }

  for (const platform of PLATFORMS) {
    const states = CHANNELS.map((channel) => {
      const status = statuses[envKey(platform, channel)];
      return `${channel}:${status}`;
    });
    const unique = new Set(states.map((item) => item.split(':')[1]).filter((status) => status !== 'skipped'));
    if (unique.size > 1) {
      return {
        label: 'inconsistent',
        reason: `${platform} differs across channels (${states.join(', ')})`,
      };
    }
  }

  if (PLATFORMS.some((platform) => statuses[envKey(platform, 'nightly')] === 'warning')) {
    return {
      label: 'warning',
      reason: 'Nightly has warning-driven failures',
    };
  }

  return {
    label: 'ok',
    reason: 'No regression or inconsistency detected',
  };
}

function buildRows(data: DataMap): RowData[] {
  const rowMap = new Map<string, RowData>();

  for (const env of ENVIRONMENTS) {
    const envData = data[env];
    if (!envData) continue;

    for (const result of envData.results) {
      const identifier = getIdentifier(result.source);
      if (!rowMap.has(identifier)) {
        rowMap.set(identifier, {
          identifier,
          results: createEmptyResults(),
          statuses: createEmptyStatuses(),
          label: '',
          reason: '',
          issueCount: 0,
        });
      }

      rowMap.get(identifier)!.results[env] = result;
    }
  }

  const rows = Array.from(rowMap.values());
  for (const row of rows) {
    for (const env of ENVIRONMENTS) {
      row.statuses[env] = getOverallStatus(row.results[env]);
    }

    const classification = classifyRow(row.statuses);
    row.label = classification.label;
    row.reason = classification.reason;
    row.issueCount = ENVIRONMENTS.reduce((sum, env) => sum + countResultIssues(row.results[env]), 0);
  }

  rows.sort((a, b) => LABEL_PRIORITY[a.label] - LABEL_PRIORITY[b.label]);
  return rows;
}

function filterRows(
  rows: RowData[],
  labelFilter: FilterLabel,
  search: string,
  showOkRows: boolean,
): RowData[] {
  const keyword = search.trim().toLowerCase();

  return rows.filter((row) => {
    if (!showOkRows && row.label === 'ok') return false;
    if (labelFilter !== 'all' && row.label !== labelFilter) return false;
    if (keyword.length > 0 && !row.identifier.toLowerCase().includes(keyword)) return false;
    return true;
  });
}

function countLabels(rows: RowData[]): Record<FilterLabel, number> {
  const counts: Record<FilterLabel, number> = {
    all: rows.length,
    regression: 0,
    warning: 0,
    inconsistent: 0,
    ok: 0,
  };

  for (const row of rows) {
    if (row.label === 'regression') counts.regression += 1;
    if (row.label === 'warning') counts.warning += 1;
    if (row.label === 'inconsistent') counts.inconsistent += 1;
    if (row.label === 'ok') counts.ok += 1;
  }

  return counts;
}

async function openLogsInNewTab(
  result: BuildResult | null,
  command: (typeof COMMANDS)[number],
  backend: (typeof BACKENDS)[number],
) {
  if (!result) return;

  let content = '';
  if (result.error) {
    content += `Error: ${result.error}\n\n`;
  } else if (result.cbt) {
    const res = result.cbt[command][backend];
    content += `=== ${command.toUpperCase()} - ${backend} ===\n`;
    content += `Status: ${res.status}\n`;
    if (res.status === 'WarningFailure' && 'matchedWarnings' in res && res.matchedWarnings.length > 0) {
      content += `Matched warnings: ${res.matchedWarnings.join(', ')}\n`;
    }

    if (res.status !== 'Skipped' && 'stdout_path' in res && 'stderr_path' in res) {
      if ('start_time' in res) content += `Start Time: ${res.start_time}\n`;
      if ('elapsed' in res) content += `Elapsed: ${res.elapsed}ms\n`;
      content += '\n';

      try {
        const stderrResp = await fetch(`${res.stderr_path}`);
        const stderrText = stderrResp.ok ? await stderrResp.text() : `Failed to fetch stderr (${stderrResp.status})`;
        const stdoutResp = await fetch(`${res.stdout_path}`);
        const stdoutText = stdoutResp.ok ? await stdoutResp.text() : `Failed to fetch stdout (${stdoutResp.status})`;
        content += `STDERR:\n${stderrText}\n\n`;
        content += `STDOUT:\n${stdoutText}\n\n`;
      } catch (error) {
        content += `Error fetching logs: ${error instanceof Error ? error.message : String(error)}\n`;
      }
    }
  }

  if (!content.trim()) {
    content = 'No stderr/stdout output available.';
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf8' });
  const url = URL.createObjectURL(blob);
  const newTab = globalThis.open(url, '_blank');
  if (newTab) {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function SummaryCell({ status }: { status: CellStatus }) {
  return html`
    <td
      style="text-align: center; padding: 6px; border: 1px solid #cbd5e1; background: ${STATUS_COLORS[
        status
      ]}; color: white; font-weight: 700; font-size: 11px;"
    >
      ${STATUS_LABELS[status]}
    </td>
  `;
}

function DetailCell({
  result,
  command,
  backend,
}: {
  result: BuildResult | null;
  command: (typeof COMMANDS)[number];
  backend: (typeof BACKENDS)[number];
}) {
  let status: CellStatus = 'skipped';
  if (result?.cbt) {
    status = getResultStatus(result.cbt[command][backend]);
  } else if (result?.error) {
    status = 'error';
  }

  return html`
    <td
      style="text-align: center; padding: 4px; border: 1px solid #cbd5e1; background: ${STATUS_COLORS[
        status
      ]}; color: white; cursor: pointer; font-weight: 700;"
      title="Click to open ${command} ${backend} logs"
      onClick="${() => openLogsInNewTab(result, command, backend)}"
    >
      ${STATUS_LABELS[status]}
    </td>
  `;
}

function LabelBadge({ label }: { label: Label }) {
  return html`
    <span
      style="display: inline-block; padding: 2px 8px; border-radius: 999px; background: ${LABEL_COLORS[
        label
      ]}; color: white; font-weight: 700; font-size: 11px;"
    >
      ${label || '-'}
    </span>
  `;
}

function ExpandedDetails({
  row,
  showAllDetails,
}: {
  row: RowData;
  showAllDetails: boolean;
}) {
  const envErrors: Array<{ env: EnvironmentKey; message: string }> = [];
  const detailRows: Array<{ env: EnvironmentKey; backend: (typeof BACKENDS)[number] }> = [];

  for (const env of ENVIRONMENTS) {
    const result = row.results[env];
    if (result?.error) {
      envErrors.push({ env, message: result.error });
    }

    if (!result?.cbt) continue;

    for (const backend of BACKENDS) {
      if (showAllDetails) {
        detailRows.push({ env, backend });
        continue;
      }

      const hasIssue = COMMANDS.some((command) => {
        const status = getResultStatus(result.cbt![command][backend]);
        return isIssueStatus(status);
      });
      if (hasIssue) {
        detailRows.push({ env, backend });
      }
    }
  }

  if (envErrors.length === 0 && detailRows.length === 0) {
    return html`
      <div style="padding: 8px 0; color: #64748b; font-size: 12px;">No detail rows for current filter.</div>
    `;
  }

  return html`
    <div style="padding: 12px; background: #f8fafc; border-top: 1px solid #e2e8f0;">
      ${envErrors.length > 0
        ? html`
          <div style="margin-bottom: 10px;">
            ${envErrors.map((item) =>
              html`
                <div
                  style="padding: 6px 8px; margin-bottom: 4px; background: #fff7ed; border: 1px solid #fdba74; border-radius: 4px; font-size: 12px;"
                >
                  <strong>${item.env}</strong>: ${item.message}
                </div>
              `
            )}
          </div>
        `
        : ''} ${detailRows.length > 0
        ? html`
          <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
            <thead>
              <tr style="background: #334155; color: white;">
                <th style="padding: 6px; border: 1px solid #cbd5e1; text-align: left;">Environment</th>
                <th style="padding: 6px; border: 1px solid #cbd5e1; text-align: left;">Backend</th>
                <th style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;">Check</th>
                <th style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;">Build</th>
                <th style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;">Test</th>
              </tr>
            </thead>
            <tbody>
              ${detailRows.map(({ env, backend }, idx) =>
                html`
                  <tr style="background: ${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};">
                    <td style="padding: 6px; border: 1px solid #cbd5e1; font-family: monospace;">${env}</td>
                    <td style="padding: 6px; border: 1px solid #cbd5e1; font-family: monospace;">${backend}</td>
                    ${COMMANDS.map((command) =>
                      html`
                        <${DetailCell} result="${row.results[env]}" command="${command}" backend="${backend}" />
                      `
                    )}
                  </tr>
                `
              )}
            </tbody>
          </table>
        `
        : ''}
    </div>
  `;
}

function App() {
  const [data, setData] = useState<DataMap>({});
  const [loading, setLoading] = useState(true);
  const [labelFilter, setLabelFilter] = useState<FilterLabel>('all');
  const [search, setSearch] = useState('');
  const [showAllDetails, setShowAllDetails] = useState(false);
  const [showOkRows, setShowOkRows] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  useEffect(() => {
    async function fetchData() {
      const newData: DataMap = {};

      await Promise.all(
        ENVIRONMENTS.map(async (env) => {
          try {
            const response = await fetch(`data/${env}/data.jsonl`);
            const results: BuildResult[] = [];
            const reader = response.body?.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream())
              .pipeThrough(new JsonParseStream()).getReader();

            if (!reader) {
              newData[env] = { metadata: null, results: [] };
              return;
            }

            const { value: metadata } = await reader.read();
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              results.push(value as unknown as BuildResult);
            }

            newData[env] = { metadata: metadata as unknown as MetaData, results };
          } catch (error) {
            console.error(`Error fetching data for ${env}:`, error);
            newData[env] = { metadata: null, results: [] };
          }
        }),
      );

      setData(newData);
      setLoading(false);
    }

    fetchData();
  }, []);

  const rows = useMemo(() => buildRows(data), [data]);
  const filteredRows = useMemo(() => filterRows(rows, labelFilter, search, showOkRows), [
    rows,
    labelFilter,
    search,
    showOkRows,
  ]);
  const counts = useMemo(() => countLabels(rows), [rows]);

  const toggleExpanded = (id: string) => {
    setExpandedRows((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (loading) {
    return html`
      <div style="padding: 20px;">Loading...</div>
    `;
  }

  return html`
    <div
      style="padding: 20px; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a;"
    >
      <h1 style="margin: 0 0 12px 0;">MoonBit Build Dashboard</h1>

      <div style="margin-bottom: 14px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
        ${(['all', 'regression', 'warning', 'inconsistent', 'ok'] as const).map((label) =>
          html`
            <button
              style="border: 1px solid #cbd5e1; background: ${labelFilter === label
                ? '#0f172a'
                : 'white'}; color: ${labelFilter === label
                ? 'white'
                : '#0f172a'}; padding: 6px 10px; border-radius: 999px; cursor: pointer; font-size: 12px; font-weight: 600;"
              onClick="${() => setLabelFilter(label)}"
            >
              ${label} (${counts[label]})
            </button>
          `
        )}

        <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; margin-left: 8px;">
          <input
            type="checkbox"
            checked="${showOkRows}"
            onChange="${(event: Event) => setShowOkRows((event.target as HTMLInputElement).checked)}"
          />
          show ok rows
        </label>

        <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px;">
          <input
            type="checkbox"
            checked="${showAllDetails}"
            onChange="${(event: Event) => setShowAllDetails((event.target as HTMLInputElement).checked)}"
          />
          show all details
        </label>

        <input
          type="text"
          placeholder="Search package/repo"
          value="${search}"
          onInput="${(event: Event) => setSearch((event.target as HTMLInputElement).value)}"
          style="margin-left: auto; min-width: 220px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px 8px;"
        />
      </div>

      <div style="margin-bottom: 10px; font-size: 12px; color: #475569;">
        Showing ${filteredRows.length} of ${rows.length} packages
      </div>

      <table style="width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed;">
        <thead>
          <tr style="background: #1e293b; color: white;">
            <th rowspan="2" style="padding: 8px; border: 1px solid #cbd5e1; width: 280px;">Source</th>
            ${PLATFORMS.map((platform) =>
              html`
                <th colspan="${CHANNELS.length}" style="padding: 8px; border: 1px solid #cbd5e1;">${platform}</th>
              `
            )}
            <th rowspan="2" style="padding: 8px; border: 1px solid #cbd5e1; width: 95px;">Label</th>
            <th rowspan="2" style="padding: 8px; border: 1px solid #cbd5e1; width: 280px;">Reason</th>
            <th rowspan="2" style="padding: 8px; border: 1px solid #cbd5e1; width: 90px;">Issues</th>
            <th rowspan="2" style="padding: 8px; border: 1px solid #cbd5e1; width: 90px;">Details</th>
          </tr>
          <tr style="background: #334155; color: white;">
            ${PLATFORMS.map((platform) =>
              CHANNELS.map((channel) => {
                const env = envKey(platform, channel);
                const shortName = channel === 'pre-release' ? 'pre' : channel;
                return html`
                  <th key="${env}" style="padding: 6px; border: 1px solid #cbd5e1;">${shortName}</th>
                `;
              })
            )}
          </tr>
        </thead>

        <tbody>
          ${filteredRows.map((row, index) => {
            const isExpanded = !!expandedRows[row.identifier];

            return html`
              <tr style="background: ${index % 2 === 0 ? '#f8fafc' : 'white'};">
                <td
                  style="padding: 6px; border: 1px solid #cbd5e1; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"
                  title="${row.identifier}"
                >
                  ${row.identifier}
                </td>

                ${PLATFORMS.map((platform) =>
                  CHANNELS.map((channel) => {
                    const env = envKey(platform, channel);
                    return html`
                      <${SummaryCell} key="${env}" status="${row.statuses[env]}" />
                    `;
                  })
                )}

                <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;"><${LabelBadge} label="${row
                  .label}" /></td>
                <td style="padding: 6px; border: 1px solid #cbd5e1; color: #334155;">${row.reason}</td>
                <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center; font-weight: 700;">${row
                  .issueCount}</td>
                <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;">
                  <button
                    onClick="${() => toggleExpanded(row.identifier)}"
                    style="border: 1px solid #cbd5e1; border-radius: 6px; background: white; cursor: pointer; font-size: 11px; padding: 4px 8px;"
                  >
                    ${isExpanded ? 'Hide' : 'Show'}
                  </button>
                </td>
              </tr>

              ${isExpanded
                ? html`
                  <tr>
                    <td colspan="15" style="padding: 0; border: 1px solid #cbd5e1; border-top: 0;">
                      <${ExpandedDetails} row="${row}" showAllDetails="${showAllDetails}" />
                    </td>
                  </tr>
                `
                : ''}
            `;
          })}
        </tbody>
      </table>

      <div
        style="margin-top: 14px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; font-size: 12px;"
      >
        <div style="margin-bottom: 6px;">
          <strong>Legend:</strong> S=Success, W=WarningFailure, F=Failure, -=Skipped, E=Source Error
        </div>
        <div style="display: flex; gap: 14px; flex-wrap: wrap;">
          ${(['success', 'warning', 'failure', 'skipped', 'error'] as const).map((status) =>
            html`
              <div>
                <span
                  style="display: inline-block; width: 12px; height: 12px; background: ${STATUS_COLORS[
                    status
                  ]}; margin-right: 4px;"
                ></span>${status}
              </div>
            `
          )}
        </div>
        <div style="margin-top: 8px; color: #64748b;">
          Click any detail matrix cell to open logs for that command/backend.
        </div>
      </div>
    </div>
  `;
}

render(
  html`
    <${App} />
  `,
  document.body,
);
