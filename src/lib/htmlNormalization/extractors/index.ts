// Extractor registry — the one place a new input format gets wired in.
//
// To add support for a new source format: implement InputExtractor
// (../types.ts) in a new file here and add it to this array. Nothing
// elsewhere in the pipeline (sanitize/canonicalize/validate/pipeline.ts) or
// in the frontend needs to know it exists.

import type { InputExtractor } from '../types'
import { htmlExtractor } from './htmlExtractor'

export const EXTRACTORS: InputExtractor[] = [htmlExtractor]

export function findExtractorFor(file: File): InputExtractor | null {
  return EXTRACTORS.find((e) => e.canHandle(file)) ?? null
}
