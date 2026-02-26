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

type Platform = 'mac' | 'linux' | 'windows';
type Channel = 'stable' | 'nightly' | 'pre-release';
type Label = 'regression' | 'warning' | 'inconsistent' | 'ok' | '';
type FilterLabel = 'all' | 'regression' | 'warning' | 'inconsistent' | 'ok';
type CellStatus = 'success' | 'warning' | 'failure' | 'skipped' | 'error';

type EnvironmentKey = `${Platform}/${Channel}`;

const platforms: Platform[] = ['mac', 'linux', 'windows'];
const channels: Channel[] = ['stable', 'nightly', 'pre-release'];
const commands = ['check', 'build', 'test'] as const;
const backends = ['wasm', 'wasm-gc', 'js', 'native'] as const;

const statusColors: Record<CellStatus, string> = {
  success: '#22c55e',
  warning: '#d97706',
  failure: '#ef4444',
  skipped: '#94a3b8',
  error: '#f97316',
};

const statusLabels: Record<CellStatus, string> = {
  success: 'S',
  warning: 'W',
  failure: 'F',
  skipped: '-',
  error: 'E',
};

type RowData = {
  identifier: string;
  source: BuildResult['source'];
  'mac/nightly': BuildResult | null;
  'mac/stable': BuildResult | null;
  'mac/pre-release': BuildResult | null;
  'linux/nightly': BuildResult | null;
  'linux/stable': BuildResult | null;
  'linux/pre-release': BuildResult | null;
  'windows/nightly': BuildResult | null;
  'windows/stable': BuildResult | null;
  'windows/pre-release': BuildResult | null;
  label: Label;
  reason: string;
};

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

  let hasWarningFailure = false;
  for (const cmd of commands) {
    for (const backend of backends) {
      const res = result.cbt[cmd][backend];
      if (res.status === 'Failure') return 'failure';
      if (res.status === 'WarningFailure') hasWarningFailure = true;
    }
  }

  return hasWarningFailure ? 'warning' : 'success';
}

function getEnvironmentStatuses(row: RowData): Record<EnvironmentKey, CellStatus> {
  const statuses = {} as Record<EnvironmentKey, CellStatus>;
  for (const platform of platforms) {
    for (const channel of channels) {
      const key = `${platform}/${channel}` as EnvironmentKey;
      statuses[key] = getOverallStatus(row[key]);
    }
  }
  return statuses;
}

function buildReasonAndLabel(row: RowData): { label: Label; reason: string } {
  const statuses = getEnvironmentStatuses(row);

  for (const platform of platforms) {
    const nightly = statuses[`${platform}/nightly`];
    const stable = statuses[`${platform}/stable`];
    if (nightly === 'failure' && stable === 'success') {
      return {
        label: 'regression',
        reason: `${platform}: nightly failed while stable succeeded`,
      };
    }
  }

  for (const platform of platforms) {
    const nightly = statuses[`${platform}/nightly`];
    const stable = statuses[`${platform}/stable`];
    if (nightly === 'warning' && stable === 'success') {
      return {
        label: 'warning',
        reason: `${platform}: nightly failed due warning checks while stable succeeded`,
      };
    }
  }

  const inconsistentReasons: string[] = [];

  for (const channel of channels) {
    const platformStates = platforms.map((platform) => {
      const key = `${platform}/${channel}` as EnvironmentKey;
      return `${platform}:${statuses[key]}`;
    });
    const normalized = platformStates.map((s) => s.split(':')[1]).filter((s) => s !== 'skipped');
    if (new Set(normalized).size > 1) {
      inconsistentReasons.push(`${channel} differs across OS (${platformStates.join(', ')})`);
    }
  }

  for (const platform of platforms) {
    const channelStates = channels.map((channel) => {
      const key = `${platform}/${channel}` as EnvironmentKey;
      return `${channel}:${statuses[key]}`;
    });
    const normalized = channelStates.map((s) => s.split(':')[1]).filter((s) => s !== 'skipped');
    if (new Set(normalized).size > 1) {
      inconsistentReasons.push(`${platform} differs across channels (${channelStates.join(', ')})`);
    }
  }

  if (inconsistentReasons.length > 0) {
    return {
      label: 'inconsistent',
      reason: inconsistentReasons[0],
    };
  }

  if (platforms.some((platform) => statuses[`${platform}/nightly`] === 'warning')) {
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

function getIssueCount(result: BuildResult | null): number {
  if (!result) return 0;
  if (result.error) return 1;
  if (!result.cbt) return 0;

  let issueCount = 0;
  for (const cmd of commands) {
    for (const backend of backends) {
      const status = getResultStatus(result.cbt[cmd][backend]);
      if (status === 'failure' || status === 'warning' || status === 'error') {
        issueCount += 1;
      }
    }
  }
  return issueCount;
}

async function openLogsInNewTab(
  result: BuildResult | null,
  command: (typeof commands)[number],
  backend: (typeof backends)[number],
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
        content += 'STDERR:\n' + stderrText + '\n\n';
        content += 'STDOUT:\n' + stdoutText + '\n\n';
      } catch (e) {
        content += `Error fetching logs: ${e instanceof Error ? e.message : String(e)}\n`;
      }
    }
  }

  if (!content.trim()) content = 'No stderr/stdout output available.';
  const blob = new Blob([content], { type: 'text/plain;charset=utf8' });
  const url = URL.createObjectURL(blob);
  const newTab = globalThis.open(url, '_blank');
  if (newTab) setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SummaryCell({ status }: { status: CellStatus }) {
  return html`
    <td
      style="text-align: center; padding: 6px; border: 1px solid #cbd5e1; background: ${statusColors[
        status
      ]}; color: white; font-weight: 700; font-size: 11px;"
    >
      ${statusLabels[status]}
    </td>
  `;
}

function CommandCell({
  result,
  command,
  backend,
}: {
  result: BuildResult | null;
  command: (typeof commands)[number];
  backend: (typeof backends)[number];
}) {
  let status: CellStatus = 'skipped';

  if (result?.cbt) {
    status = getResultStatus(result.cbt[command][backend]);
  } else if (result?.error) {
    status = 'error';
  }

  const handleClick = () => {
    openLogsInNewTab(result, command, backend);
  };

  return html`
    <td
      style="text-align: center; padding: 4px; border: 1px solid #cbd5e1; background: ${statusColors[
        status
      ]}; color: white; cursor: pointer; font-weight: 700;"
      title="Click to open ${command} ${backend} logs"
      onClick="${handleClick}"
    >
      ${statusLabels[status]}
    </td>
  `;
}

function LabelBadge({ label }: { label: Label }) {
  const colors: Record<Label, string> = {
    regression: '#dc2626',
    warning: '#d97706',
    inconsistent: '#f59e0b',
    ok: '#16a34a',
    '': '#64748b',
  };

  return html`
    <span
      style="display: inline-block; padding: 2px 8px; border-radius: 999px; background: ${colors[
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
  const detailRows: Array<{ env: EnvironmentKey; backend: (typeof backends)[number] }> = [];

  for (const platform of platforms) {
    for (const channel of channels) {
      const env = `${platform}/${channel}` as EnvironmentKey;
      const result = row[env];
      if (!result?.cbt) continue;

      for (const backend of backends) {
        if (showAllDetails) {
          detailRows.push({ env, backend });
          continue;
        }

        const statuses = commands.map((command) => getResultStatus(result.cbt![command][backend]));
        const hasIssue = statuses.some((status) => status === 'failure' || status === 'warning' || status === 'error');
        if (hasIssue) {
          detailRows.push({ env, backend });
        }
      }
    }
  }

  const envErrors: Array<{ env: EnvironmentKey; message: string }> = [];
  for (const platform of platforms) {
    for (const channel of channels) {
      const env = `${platform}/${channel}` as EnvironmentKey;
      const result = row[env];
      if (result?.error) {
        envErrors.push({ env, message: result.error });
      }
    }
  }

  if (detailRows.length === 0 && envErrors.length === 0) {
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
              ${detailRows.map(({ env, backend }, idx) => {
                const result = row[env];
                return html`
                  <tr style="background: ${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};">
                    <td style="padding: 6px; border: 1px solid #cbd5e1; font-family: monospace;">${env}</td>
                    <td style="padding: 6px; border: 1px solid #cbd5e1; font-family: monospace;">${backend}</td>
                    ${commands.map((command) =>
                      html`
                        <${CommandCell} result="${result}" command="${command}" backend="${backend}" />
                      `
                    )}
                  </tr>
                `;
              })}
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
      const keys: EnvironmentKey[] = [];

      for (const os of platforms) {
        for (const channel of channels) {
          keys.push(`${os}/${channel}` as EnvironmentKey);
        }
      }

      await Promise.all(
        keys.map(async (key) => {
          try {
            const response = await fetch(`data/${key}/data.jsonl`);
            const results = [];
            const reader = response.body!.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream())
              .pipeThrough(new JsonParseStream()).getReader();
            const { value: metadata } = await reader.read();
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              results.push(value as unknown as BuildResult);
            }
            newData[key] = { metadata: metadata as unknown as MetaData, results };
          } catch (error) {
            console.error(`Error fetching data for ${key}:`, error);
            newData[key] = { metadata: null, results: [] };
          }
        }),
      );

      setData(newData);
      setLoading(false);
    }

    fetchData();
  }, []);

  const rows = useMemo(() => {
    const output: RowData[] = [];
    const identifierMap = new Map<string, RowData>();

    for (const [key, value] of Object.entries(data)) {
      const envKey = key as EnvironmentKey;
      for (const result of value.results) {
        const id = getIdentifier(result.source);

        if (!identifierMap.has(id)) {
          identifierMap.set(id, {
            identifier: id,
            source: result.source,
            'mac/nightly': null,
            'mac/stable': null,
            'mac/pre-release': null,
            'linux/nightly': null,
            'linux/stable': null,
            'linux/pre-release': null,
            'windows/nightly': null,
            'windows/stable': null,
            'windows/pre-release': null,
            label: '',
            reason: '',
          });
        }

        const row = identifierMap.get(id)!;
        row[envKey] = result;
      }
    }

    for (const row of identifierMap.values()) {
      const { label, reason } = buildReasonAndLabel(row);
      row.label = label;
      row.reason = reason;
      output.push(row);
    }

    output.sort((a, b) => {
      const priority: Record<Label, number> = { regression: 0, warning: 1, inconsistent: 2, ok: 3, '': 4 };
      return priority[a.label] - priority[b.label];
    });

    return output;
  }, [data]);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (!showOkRows && row.label === 'ok') return false;
      if (labelFilter !== 'all' && row.label !== labelFilter) return false;
      if (search.trim().length > 0 && !row.identifier.toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    });
  }, [rows, labelFilter, search, showOkRows]);

  const counts = useMemo(() => {
    const counter: Record<FilterLabel, number> = {
      all: rows.length,
      regression: 0,
      warning: 0,
      inconsistent: 0,
      ok: 0,
    };

    for (const row of rows) {
      if (row.label === 'regression') counter.regression += 1;
      if (row.label === 'warning') counter.warning += 1;
      if (row.label === 'inconsistent') counter.inconsistent += 1;
      if (row.label === 'ok') counter.ok += 1;
    }

    return counter;
  }, [rows]);

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
        ${(['all', 'regression', 'warning', 'inconsistent', 'ok'] as FilterLabel[]).map((label) =>
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
          <input type="checkbox" checked="${showOkRows}" onChange="${(e: Event) =>
            setShowOkRows((e.target as HTMLInputElement).checked)}" />
          show ok rows
        </label>

        <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px;">
          <input type="checkbox" checked="${showAllDetails}" onChange="${(e: Event) =>
            setShowAllDetails((e.target as HTMLInputElement).checked)}" />
          show all details
        </label>

        <input
          type="text"
          placeholder="Search package/repo"
          value="${search}"
          onInput="${(e: Event) => setSearch((e.target as HTMLInputElement).value)}"
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
            <th colspan="3" style="padding: 8px; border: 1px solid #cbd5e1;">mac</th>
            <th colspan="3" style="padding: 8px; border: 1px solid #cbd5e1;">linux</th>
            <th colspan="3" style="padding: 8px; border: 1px solid #cbd5e1;">windows</th>
            <th rowspan="2" style="padding: 8px; border: 1px solid #cbd5e1; width: 95px;">Label</th>
            <th rowspan="2" style="padding: 8px; border: 1px solid #cbd5e1; width: 280px;">Reason</th>
            <th rowspan="2" style="padding: 8px; border: 1px solid #cbd5e1; width: 90px;">Issues</th>
            <th rowspan="2" style="padding: 8px; border: 1px solid #cbd5e1; width: 90px;">Details</th>
          </tr>
          <tr style="background: #334155; color: white;">
            ${platforms.map(() =>
              channels.map((channel) =>
                html`
                  <th style="padding: 6px; border: 1px solid #cbd5e1;">${channel === 'pre-release'
                    ? 'pre'
                    : channel}</th>
                `
              )
            )}
          </tr>
        </thead>

        <tbody>
          ${filteredRows.map((row, idx) => {
            const isExpanded = !!expandedRows[row.identifier];
            const issueCount = channels.reduce((count, channel) => {
              return count +
                platforms.reduce(
                  (acc, platform) => acc + getIssueCount(row[`${platform}/${channel}` as EnvironmentKey]),
                  0,
                );
            }, 0);

            return html`
              <tr style="background: ${idx % 2 === 0 ? '#f8fafc' : 'white'};">
                <td
                  style="padding: 6px; border: 1px solid #cbd5e1; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"
                  title="${row.identifier}"
                >
                  ${row.identifier}
                </td>

                ${platforms.map((platform) =>
                  channels.map((channel) => {
                    const status = getOverallStatus(row[`${platform}/${channel}` as EnvironmentKey]);
                    return html`
                      <${SummaryCell} status="${status}" />
                    `;
                  })
                )}

                <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;"><${LabelBadge} label="${row
                  .label}" /></td>
                <td style="padding: 6px; border: 1px solid #cbd5e1; color: #334155;">${row.reason}</td>
                <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center; font-weight: 700;">${issueCount}</td>
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
          ${(['success', 'warning', 'failure', 'skipped', 'error'] as CellStatus[]).map((status) =>
            html`
              <div>
                <span
                  style="display: inline-block; width: 12px; height: 12px; background: ${statusColors[
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
