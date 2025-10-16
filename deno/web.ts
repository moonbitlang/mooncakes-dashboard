import { useEffect, useState } from 'https://esm.sh/preact/hooks';
import { html, render } from 'https://esm.sh/htm/preact';
import type { BuildResult, MetaData } from './lib/types.ts';

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

function StatusCell({ result }: { result: BuildResult | null }) {
  const status = getOverallStatus(result);
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

  return html`
    <td style="background-color: ${colors[status]}; color: white; text-align: center; padding: 8px;">
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

      for (const os of ['linux', 'windows', 'mac']) {
        for (const channel of ['nightly', 'stable']) {
          const key = `${os}-${channel}`;
          try {
            const response = await fetch(`data/${key}.jsonl`);
            const text = await response.text();
            const lines = text.trim().split('\n').filter((line) => line);

            if (lines.length === 0) {
              newData[key] = { metadata: null, results: [] };
              continue;
            }

            const metadata = JSON.parse(lines[0]) as MetaData;
            const results = lines.slice(1).map((line) => JSON.parse(line) as BuildResult);

            newData[key] = { metadata, results };
          } catch (error) {
            console.error(`Error fetching data for ${key}:`, error);
            newData[key] = { metadata: null, results: [] };
          }
        }
      }

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

      <table style="border-collapse: collapse; width: 100%; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <thead>
          <tr style="background-color: #1e293b; color: white;">
            <th style="padding: 12px; text-align: center; border: 1px solid #cbd5e1;">Source</th>
            <th style="padding: 12px; text-align: center; border: 1px solid #cbd5e1;" colspan="2">Mac</th>
            <th style="padding: 12px; text-align: center; border: 1px solid #cbd5e1;" colspan="2">Linux</th>
            <th style="padding: 12px; text-align: center; border: 1px solid #cbd5e1;" colspan="2">Windows</th>
            <th style="padding: 12px; text-align: center; border: 1px solid #cbd5e1;">Label</th>
          </tr>
          <tr style="background-color: #334155; color: white;">
            <th style="padding: 8px; border: 1px solid #cbd5e1;"></th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;">Stable</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;">Nightly</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;">Stable</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;">Nightly</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;">Stable</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;">Nightly</th>
            <th style="padding: 8px; text-align: center; border: 1px solid #cbd5e1;"></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, idx) =>
            html`
              <tr style="background-color: ${idx % 2 === 0 ? '#f8fafc' : 'white'};">
                <td style="padding: 8px; border: 1px solid #cbd5e1; font-family: monospace; font-size: 12px;">
                  ${row.identifier}
                </td>
                <${StatusCell} result="${row['mac-stable']}" />
                <${StatusCell} result="${row['mac-nightly']}" />
                <${StatusCell} result="${row['linux-stable']}" />
                <${StatusCell} result="${row['linux-nightly']}" />
                <${StatusCell} result="${row['windows-stable']}" />
                <${StatusCell} result="${row['windows-nightly']}" />
                <${LabelCell} label="${row.label}" />
              </tr>
            `
          )}
        </tbody>
      </table>

      <div style="margin-top: 20px; padding: 10px; background-color: #f1f5f9; border-radius: 4px;">
        <h3 style="margin-top: 0;">Legend:</h3>
        <div style="display: flex; gap: 20px; flex-wrap: wrap;">
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
