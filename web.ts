import { useEffect, useState } from 'https://esm.sh/preact/hooks';
import { html, render } from 'https://esm.sh/htm/preact';
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
  'mac-nightly': BuildResult | null;
  'mac-stable': BuildResult | null;
  'linux-nightly': BuildResult | null;
  'linux-stable': BuildResult | null;
  'windows-nightly': BuildResult | null;
  'windows-stable': BuildResult | null;
  label: 'regression' | 'inconsistent' | 'ok' | '';
};

function getIdentifier(source: BuildResult['source']): string {
  if (source.type === 'mooncakes') {
    return `${source.name}@${source.version}`;
  } else {
    return `${source.url}#${source.rev}`;
  }
}

function getResultStatus(res: Result): 'success' | 'failure' | 'skipped' {
  if (res.status === 'Success') return 'success';
  if (res.status === 'Failure') return 'failure';
  return 'skipped';
}

function getOverallStatus(result: BuildResult | null): 'success' | 'failure' | 'skipped' | 'error' {
  if (!result) return 'skipped';
  if (result.error) return 'error';
  if (!result.cbt) return 'skipped';

  for (const cmd of ['check', 'build', 'test'] as const) {
    for (const backend of ['wasm', 'wasm-gc', 'js', 'native'] as const) {
      const res = result.cbt[cmd][backend];
      if (res.status === 'Failure') return 'failure';
    }
  }
  return 'success';
}

function getLabel(row: RowData): 'regression' | 'inconsistent' | 'ok' | '' {
  const platforms = ['mac', 'linux', 'windows'] as const;
  const nightlyStatuses = platforms.map((p) => getOverallStatus(row[`${p}-nightly`]));
  const stableStatuses = platforms.map((p) => getOverallStatus(row[`${p}-stable`]));

  for (let i = 0; i < platforms.length; i++) {
    if (nightlyStatuses[i] === 'failure' && stableStatuses[i] === 'success') {
      return 'regression';
    }
  }

  const nightlySuccess = nightlyStatuses.filter((s) => s === 'success').length;
  const nightlyFailure = nightlyStatuses.filter((s) => s === 'failure').length;
  const stableSuccess = stableStatuses.filter((s) => s === 'success').length;
  const stableFailure = stableStatuses.filter((s) => s === 'failure').length;

  if ((nightlySuccess > 0 && nightlyFailure > 0) || (stableSuccess > 0 && stableFailure > 0)) {
    return 'inconsistent';
  }

  return 'ok';
}

function openLogsInNewTab(
  result: BuildResult | null,
  _identifier: string,
  command: 'check' | 'build' | 'test',
  backend: 'wasm' | 'wasm-gc' | 'js' | 'native',
) {
  if (!result) return;

  let content = '';

  // Add error message if present
  if (result.error) {
    content += `Error: ${result.error}\n\n`;
  }

  // Get the specific command and backend result
  if (result.cbt) {
    const res = result.cbt[command][backend];

    content += `=== ${command.toUpperCase()} - ${backend} ===\n`;
    content += `Status: ${res.status}\n`;

    if (res.status !== 'Skipped') {
      if ('start_time' in res) content += `Start Time: ${res.start_time}\n`;
      if ('elapsed' in res) content += `Elapsed: ${res.elapsed}ms\n`;
      content += '\n';

      content += 'STDERR:\n';
      content += res.stderr;
      content += '\n\n';

      content += 'STDOUT:\n';
      content += res.stdout;
      content += '\n\n';
    }
  }

  if (!content || content.trim() === '') {
    content = 'No stderr/stdout output available.';
  }

  // Create blob URL and open in new tab
  const blob = new Blob([content], { type: 'text/plain;charset=utf8' });
  const url = URL.createObjectURL(blob);
  const newTab = globalThis.open(url, '_blank');

  // Clean up the blob URL after a delay to allow the tab to load
  if (newTab) {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// Detailed cell for specific command and backend
function DetailCell({
  result,
  identifier,
  command,
  backend,
}: {
  result: BuildResult | null;
  identifier: string;
  command: 'check' | 'build' | 'test';
  backend: 'wasm' | 'wasm-gc' | 'js' | 'native';
}) {
  let status: 'success' | 'failure' | 'skipped' | 'error' = 'skipped';

  if (result && result.cbt) {
    const res = result.cbt[command][backend];
    status = getResultStatus(res);
  } else if (result && result.error) {
    status = 'error';
  }

  const colors = {
    success: '#22c55e',
    failure: '#ef4444',
    skipped: '#94a3b8',
    error: '#f97316',
  };

  const labels = {
    success: '✓',
    failure: '✗',
    skipped: '-',
    error: '!',
  };

  const handleClick = () => {
    openLogsInNewTab(result, identifier, command, backend);
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
        for (const channel of ['nightly', 'stable']) {
          const key = `${os}-${channel}`;
          keys.push(key);
        }
      }

      await Promise.all(
        keys.map(async (key) => {
          try {
            const response = await fetch(`https://moonbitlang.github.io/mooncakes-dashboard/data/${key}.jsonl`);
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
          'mac-nightly': null,
          'mac-stable': null,
          'linux-nightly': null,
          'linux-stable': null,
          'windows-nightly': null,
          'windows-stable': null,
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
    const priority = { regression: 0, inconsistent: 1, ok: 2, '': 3 };
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
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;" colspan="24">Mac</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;" colspan="24">Linux</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;" colspan="24">Windows</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;" rowspan="4">Label</th>
          </tr>
          <!-- Channel headers -->
          <tr style="background-color: #334155; color: white;">
            ${Array(3).fill(null).map(() =>
              html`
                <th style="padding: 6px; text-align: center; border: 1px solid #cbd5e1;" colspan="12">Stable</th>
                <th style="padding: 6px; text-align: center; border: 1px solid #cbd5e1;" colspan="12">Nightly</th>
              `
            )}
          </tr>
          <!-- Backend headers -->
          <tr style="background-color: #475569; color: white;">
            ${Array(6).fill(null).map(() =>
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
            ${Array(24).fill(null).map(() =>
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
            const channels = ['stable', 'nightly'] as const;
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
                        const result = row[`${platform}-${channel}`];
                        return html`
                          <${DetailCell} result="${result}" command="${cmd}" backend="${backend}" identifier="${row
                            .identifier}" />
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
