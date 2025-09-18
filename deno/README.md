# Moon Build DashBoard rewritten in TypeScript

## Goal

Check all the projects in mooncakes + projects listed in `repos.yml`, to see if they can check/build/test.

Currently, due to potential dead loops and long running tests, the tests are only type checked and built.

## Design

It is assumed that the running environment have one MoonBit toolchain set up.

For gathering the projects in mooncakes, it is done by looking up the `~/.moon/registry/index/user`.

The `exclude.yml` specifies the projects that we don't want to check. The `repos.yml` specifies how we should handle
specific projects: which backends should we look at, which os should we run on.

## Usage

The `schema.ts` will generate the JSON schema for the yaml files that provides the repos.

The `main.ts` is the entry of the main project.

When `main.ts` is executed, it will write the data to `webapp/public/${os}/latest-${channel}.jsonl`.
