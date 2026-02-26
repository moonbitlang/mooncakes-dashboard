import { useEffect, useState } from 'npm:preact/hooks';
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
  label: 'regression' | 'warning' | 'inconsistent' | 'ok' | '';
};

type CellStatus = 'success' | 'warning' | 'failure' | 'skipped' | 'error';

function getIdentifier(source: BuildResult['source']): string {
  if (source.type === 'mooncakes') {
    return `${source.name}@${source.version}`;
  } else {
    return `${source.url}#${source.rev}`;
  }
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
  for (const cmd of ['check', 'build', 'test'] as const) {
    for (const backend of ['wasm', 'wasm-gc', 'js', 'native'] as const) {
      const res = result.cbt[cmd][backend];
      if (res.status === 'Failure') return 'failure';
      if (res.status === 'WarningFailure') hasWarningFailure = true;
    }
  }
  return hasWarningFailure ? 'warning' : 'success';
}

function getLabel(row: RowData): 'regression' | 'warning' | 'inconsistent' | 'ok' | '' {
  const platforms = ['mac', 'linux', 'windows'] as const;

  const nightlyStatuses = platforms.map((p) => getOverallStatus(row[`${p}/nightly`]));
  const stableStatuses = platforms.map((p) => getOverallStatus(row[`${p}/stable`]));
  const prereleaseStatuses = platforms.map((p) => getOverallStatus(row[`${p}/pre-release`]));

  for (let i = 0; i < platforms.length; i++) {
    if (nightlyStatuses[i] === 'failure' && stableStatuses[i] === 'success') {
      return 'regression';
    }
  }

  for (let i = 0; i < platforms.length; i++) {
    if (nightlyStatuses[i] === 'warning' && stableStatuses[i] === 'success') {
      return 'warning';
    }
  }

  const hasInconsistentStatus = (statuses: CellStatus[]): boolean => {
    const normalized = statuses.filter((status) => status !== 'skipped');
    return new Set(normalized).size > 1;
  };

  if (
    hasInconsistentStatus(nightlyStatuses) ||
    hasInconsistentStatus(stableStatuses) ||
    hasInconsistentStatus(prereleaseStatuses)
  ) {
    return 'inconsistent';
  }

  if (nightlyStatuses.some((status) => status === 'warning')) {
    return 'warning';
  }

  return 'ok';
}

// 点击单元格时打开新标签并在一个文本中合并 stderr/stdout 信息
async function openLogsInNewTab(
  result: BuildResult | null,
  command: 'check' | 'build' | 'test',
  backend: 'wasm' | 'wasm-gc' | 'js' | 'native',
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

// Detailed cell for specific command and backend
function DetailCell({
  result,
  command,
  backend,
}: {
  result: BuildResult | null;
  identifier: string;
  command: 'check' | 'build' | 'test';
  backend: 'wasm' | 'wasm-gc' | 'js' | 'native';
}) {
  let status: CellStatus = 'skipped';

  if (result && result.cbt) {
    const res = result.cbt[command][backend];
    status = getResultStatus(res);
  } else if (result && result.error) {
    status = 'error';
  }

  const colors = {
    success: '#22c55e',
    warning: '#d97706',
    failure: '#ef4444',
    skipped: '#94a3b8',
    error: '#f97316',
  };

  const labels = {
    success: '✓',
    warning: 'W',
    failure: '✗',
    skipped: '-',
    error: '!',
  };

  const handleClick = () => {
    openLogsInNewTab(result, command, backend);
  };

  return html`
    <td
      style="background-color: ${colors[
        status
      ]}; color: white; text-align: center; padding: 4px; cursor: pointer; user-select: none; font-size: 12px;"
      onClick="${handleClick}"
      title="Click to open ${command} ${backend} logs"
    >
      ${labels[status]}
    </td>
  `;
}

function LabelCell({ label }: { label: string }) {
  const colors = {
    regression: '#dc2626',
    warning: '#d97706',
    inconsistent: '#f59e0b',
    ok: '#16a34a',
    '': '#64748b',
  };

  return html`
    <td style="background-color: ${colors[
      label as keyof typeof colors
    ]}; color: white; text-align: center; padding: 8px; font-weight: bold;">
      ${label || '-'}
    </td>
  `;
}

function App() {
  const [data, setData] = useState<DataMap>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      const newData: DataMap = {};
      const keys = [];

      for (const os of ['linux', 'windows', 'mac']) {
        for (const channel of ['stable', 'nightly', 'pre-release']) {
          const key = `${os}/${channel}`;
          keys.push(key);
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

  const rows: RowData[] = [];
  const identifierMap = new Map<string, RowData>();

  for (const [key, value] of Object.entries(data)) {
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
        });
      }

      const row = identifierMap.get(id)!;
      row[key as keyof RowData] = result as any;
    }
  }

  for (const row of identifierMap.values()) {
    row.label = getLabel(row);
    rows.push(row);
  }

  rows.sort((a, b) => {
    const priority = { regression: 0, warning: 1, inconsistent: 2, ok: 3, '': 4 };
    return priority[a.label] - priority[b.label];
  });

  if (loading) {
    return html`
      <div style="padding: 20px;">Loading...</div>
    `;
  }

  return html`
    <div style="padding: 20px; font-family: system-ui, -apple-system, sans-serif;">
      <h1 style="margin-bottom: 20px;">MoonBit Build Dashboard</h1>

      <table style="border-collapse: collapse; width: 100%; box-shadow: 0 1px 3px rgba(0,0,0,0.1); font-size: 11px;">
        <thead style="position: sticky; top: 0; z-index: 10;">
          <!-- Platform headers -->
          <tr style="background-color: #1e293b; color: white;">
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;" rowspan="4">Source</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;" colspan="36">Mac</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;" colspan="36">Linux</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;" colspan="36">Windows</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;" rowspan="4">Label</th>
          </tr>
          <!-- Channel headers -->
          <tr style="background-color: #334155; color: white;">
            ${Array(3).fill(null).map(() =>
              html`
                <th style="padding: 6px; text-align: center; border: 1px solid #cbd5e1;" colspan="12">Stable</th>
                <th style="padding: 6px; text-align: center; border: 1px solid #cbd5e1;" colspan="12">Nightly</th>
                <th style="padding: 6px; text-align: center; border: 1px solid #cbd5e1;" colspan="12">Pre-release</th>
              `
            )}
          </tr>
          <!-- Backend headers -->
          <tr style="background-color: #475569; color: white;">
            ${Array(9).fill(null).map(() =>
              html`
                <th style="padding: 4px; text-align: center; border: 1px solid #cbd5e1; font-size: 9px;" colspan="3">wasm</th>
                <th style="padding: 4px; text-align: center; border: 1px solid #cbd5e1; font-size: 9px;" colspan="3">wasm-gc</th>
                <th style="padding: 4px; text-align: center; border: 1px solid #cbd5e1; font-size: 9px;" colspan="3">js</th>
                <th style="padding: 4px; text-align: center; border: 1px solid #cbd5e1; font-size: 9px;" colspan="3">native</th>
              `
            )}
          </tr>
          <!-- Command headers -->
          <tr style="background-color: #64748b; color: white;">
            ${Array(36).fill(null).map(() =>
              html`
                <th style="padding: 2px; text-align: center; border: 1px solid #cbd5e1; font-size: 8px;">c</th>
                <th style="padding: 2px; text-align: center; border: 1px solid #cbd5e1; font-size: 8px;">b</th>
                <th style="padding: 2px; text-align: center; border: 1px solid #cbd5e1; font-size: 8px;">t</th>
              `
            )}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, idx) => {
            const platforms = ['mac', 'linux', 'windows'] as const;
            const channels = ['stable', 'nightly', 'pre-release'] as const;
            const commands = ['check', 'build', 'test'] as const;
            const backends = ['wasm', 'wasm-gc', 'js', 'native'] as const;

            return html`
              <tr style="background-color: ${idx % 2 === 0 ? '#f8fafc' : 'white'};">
                <td
                  style="padding: 6px; border: 1px solid #cbd5e1; font-family: monospace; font-size: 10px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                  title="${row.identifier}"
                >
                  ${row.identifier}
                </td>
                ${platforms.map((platform) =>
                  channels.map((channel) =>
                    backends.map((backend) =>
                      commands.map((cmd) => {
                        const result = row[`${platform}/${channel}`];
                        return html`
                          <${DetailCell} result="${result}" command="${cmd}" backend="${backend}" />
                        `;
                      })
                    )
                  )
                )}
                <${LabelCell} label="${row.label}" />
              </tr>
            `;
          })}
        </tbody>
      </table>

      <div style="margin-top: 20px; padding: 10px; background-color: #f1f5f9; border-radius: 4px;">
        <h3 style="margin-top: 0;">Legend:</h3>
        <p style="margin: 5px 0; font-style: italic; color: #64748b;">
          💡 Click on any cell to view logs in a new tab
        </p>
        <div style="margin-top: 10px;">
          <p style="margin: 5px 0;"><strong>Headers:</strong></p>
          <ul style="margin: 5px 0; padding-left: 20px; font-size: 12px;">
            <li>
              <strong>c</strong> = check, <strong>b</strong> = build, <strong>t</strong> = test
            </li>
          </ul>
        </div>
        <div style="display: flex; gap: 20px; flex-wrap: wrap; margin-top: 10px;">
          <div>
            <span
              style="display: inline-block; width: 20px; height: 20px; background-color: #22c55e; margin-right: 5px;"
            ></span>Success
          </div>
          <div>
            <span
              style="display: inline-block; width: 20px; height: 20px; background-color: #d97706; margin-right: 5px;"
            ></span>WarningFailure
          </div>
          <div>
            <span
              style="display: inline-block; width: 20px; height: 20px; background-color: #ef4444; margin-right: 5px;"
            ></span>Failure
          </div>
          <div>
            <span
              style="display: inline-block; width: 20px; height: 20px; background-color: #94a3b8; margin-right: 5px;"
            ></span>Skipped
          </div>
          <div>
            <span
              style="display: inline-block; width: 20px; height: 20px; background-color: #f97316; margin-right: 5px;"
            ></span>Error
          </div>
        </div>
        <div style="margin-top: 10px; display: flex; gap: 20px; flex-wrap: wrap;">
          <div>
            <strong
              style="display: inline-block; padding: 2px 8px; background-color: #dc2626; color: white; margin-right: 5px;"
            >regression</strong>Nightly failed but stable succeeded
          </div>
          <div>
            <strong
              style="display: inline-block; padding: 2px 8px; background-color: #d97706; color: white; margin-right: 5px;"
            >warning</strong>Nightly failed due configured warning checks
          </div>
          <div>
            <strong
              style="display: inline-block; padding: 2px 8px; background-color: #f59e0b; color: white; margin-right: 5px;"
            >inconsistent</strong>Different results across platforms
          </div>
          <div>
            <strong
              style="display: inline-block; padding: 2px 8px; background-color: #16a34a; color: white; margin-right: 5px;"
            >ok</strong>Consistent results
          </div>
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
