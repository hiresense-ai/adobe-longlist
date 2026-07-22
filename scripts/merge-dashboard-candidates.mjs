#!/usr/bin/env node
// CLI wrapper around the shared merge algorithm in
// src/lib/dashboardCandidateMerge.ts (also used by the in-app "Update
// Candidates" admin feature) — this file only handles argv parsing and
// file I/O; the actual merge logic lives in exactly one place.
//
// Usage:
//   node scripts/merge-dashboard-candidates.mjs --html <path> --csv <path> [--out <path>]
//
// If --out is omitted, writes "<html-without-ext>.merged.html" next to the
// input — it never overwrites --html in place.

import fs from 'node:fs'
import path from 'node:path'
import { mergeCandidatesIntoHtml } from '../src/lib/dashboardCandidateMerge.ts'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const value =
        argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
      args[key] = value
    }
  }
  return args
}

function defaultOutPath(htmlPath) {
  const ext = path.extname(htmlPath)
  const base = htmlPath.slice(0, htmlPath.length - ext.length)
  return `${base}.merged${ext}`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.html || !args.csv) {
    console.error(
      'Usage: node scripts/merge-dashboard-candidates.mjs --html <existing.html> --csv <new-candidates.csv> [--out <merged.html>]',
    )
    process.exit(1)
  }

  const htmlPath = path.resolve(args.html)
  const csvPath = path.resolve(args.csv)
  const outPath = path.resolve(args.out || defaultOutPath(htmlPath))

  const html = fs.readFileSync(htmlPath, 'utf8')
  const csvText = fs.readFileSync(csvPath, 'utf8')

  const result = mergeCandidatesIntoHtml(html, csvText)

  console.log(`Existing candidates: ${result.existingCount}`)
  console.log(`Appending:           ${result.appendedCount}`)
  console.log(`Skipping:            ${result.skipped.length}`)
  for (const s of result.skipped) {
    console.log(`  - skipped (${s.reason}): ${s.name ?? ''}`)
  }

  if (!result.mergedHtml) {
    console.log('\nNo new unique candidates to append — nothing written.')
    return
  }

  fs.writeFileSync(outPath, result.mergedHtml, 'utf8')
  console.log(`\nWrote merged dashboard to: ${outPath}`)
  console.log(`Total candidates: ${result.finalTotal}`)
}

main()
