/**
 * Host-profile descriptors: the observable knobs a host applies to an MCP App
 * (sandbox tokens, CSP, popup policy, tool-result redelivery, instance count,
 * _meta.ui.domain enforcement).
 *
 * `spec` is normative (2026-07-28 spec + ext-apps 1.7.x defaults). Every other
 * descriptor is a community-observed report — its knobs MUST cite the ext-apps
 * issue or SDK release they come from, and a descriptor with an empty
 * `sources` array is rejected at load time.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const PROFILE_NAMES = ["spec", "claude-desktop", "claude-web", "chatgpt", "grok"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export const ProfileDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  sandboxTokens: z.array(z.string().min(1)),
  csp: z.object({
    frameAncestors: z.string(),
    scriptSrc: z.string(),
    defaultSrc: z.string(),
    objectSrc: z.string(),
  }),
  popupsAllowed: z.boolean(),
  redeliversToolResult: z.boolean(),
  maxConcurrentInstances: z.number().int().min(1),
  honoursUiDomain: z.boolean(),
  sources: z
    .array(z.url())
    .min(1, "sources must cite at least one URL — a profile without evidence is not loaded"),
});
export type ProfileDescriptor = z.infer<typeof ProfileDescriptorSchema>;

function formatZodError(label: string, error: z.ZodError): string {
  const issues = error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return `profile descriptor ${label} is invalid — ${issues}`;
}

export function parseProfileDescriptor(label: string, raw: string): ProfileDescriptor {
  let json: unknown;
  try {
    // Windows editors and PowerShell redirects prepend a BOM
    json = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`profile descriptor ${label} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const parsed = ProfileDescriptorSchema.safeParse(json);
  if (!parsed.success) throw new Error(formatZodError(label, parsed.error));
  return parsed.data;
}

/** Built-in descriptors live next to this module in src/, but the bundled CLI
 * resolves import.meta.url to dist/cli.js — try both layouts. */
async function readBuiltin(name: ProfileName): Promise<string> {
  const candidates = [
    new URL(`./${name}.json`, import.meta.url),
    new URL(`./profiles/${name}.json`, import.meta.url),
  ];
  let lastError: unknown;
  for (const url of candidates) {
    try {
      return await readFile(url, "utf-8");
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`built-in profile "${name}" could not be read: ${lastError}`);
}

export function isBuiltinProfile(name: string): name is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(name);
}

/** Load a built-in profile by name, or a user descriptor by .json path. */
export async function loadProfile(nameOrPath: string): Promise<ProfileDescriptor> {
  if (isBuiltinProfile(nameOrPath)) {
    return parseProfileDescriptor(`"${nameOrPath}"`, await readBuiltin(nameOrPath));
  }
  let raw: string;
  try {
    raw = await readFile(nameOrPath, "utf-8");
  } catch (e) {
    throw new Error(
      `could not read profile descriptor "${nameOrPath}": ${e instanceof Error ? e.message : e}`,
    );
  }
  return parseProfileDescriptor(`"${nameOrPath}"`, raw);
}

export async function loadAllBuiltins(): Promise<ProfileDescriptor[]> {
  return Promise.all(PROFILE_NAMES.map((n) => loadProfile(n)));
}
