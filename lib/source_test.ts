/// <reference lib="deno.ns" />
import * as semver from '@std/semver';

Deno.test(
  {
    name: 'semver test',
    fn() {
      const version = ['0.0.2', '0.1.0-alpha-1', '0.1.0-alpha-2', '0.1.0-alpha-3', '0.1.0-alpha-4'].map((v) =>
        semver.parse(v)!
      );
      const range = semver.parseRange('*');
      const max = semver.maxSatisfying(version, range);
      console.log(max);
      for (const v of version) {
        console.log(`${semver.format(v)} in ${semver.formatRange(range)}: ${semver.satisfies(v, range)}`);
      }
    },
  },
);
