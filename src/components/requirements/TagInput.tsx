import { useState } from 'react'
import { X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

/**
 * Chip-list input for skills/companies: type a value, press Enter, get a
 * chip; × removes it. Same Badge-with-remove-button chip pattern as the
 * Upload dialog's pending-assignee list. Values are trimmed and deduped
 * case-insensitively on entry (typing "react" after adding "React" is a
 * no-op), keeping the user's original capitalization — mirroring the
 * requirements Edge Function's own normalization, which remains the
 * actual boundary.
 */
export function TagInput({
  id,
  values,
  onChange,
  placeholder,
  disabled,
}: {
  id: string
  values: string[]
  onChange: (values: string[]) => void
  placeholder: string
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')

  function commitDraft() {
    const value = draft.trim()
    if (!value) {
      setDraft('')
      return
    }
    const isDuplicate = values.some(
      (existing) => existing.toLowerCase() === value.toLowerCase(),
    )
    if (!isDuplicate) onChange([...values, value])
    setDraft('')
  }

  function removeValue(value: string) {
    onChange(values.filter((existing) => existing !== value))
  }

  return (
    <div className="grid gap-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <Badge key={value} variant="secondary" className="gap-1 pr-1">
              {value}
              <button
                type="button"
                aria-label={`Remove ${value}`}
                disabled={disabled}
                onClick={() => removeValue(value)}
                className="hover:bg-background/60 rounded-full p-0.5"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        id={id}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        // Committing on blur too means a value typed but never Enter-ed
        // still lands as a chip before the form submits.
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            // Inside a form: Enter adds a chip, never submits.
            event.preventDefault()
            commitDraft()
          } else if (event.key === 'Backspace' && !draft && values.length) {
            event.preventDefault()
            onChange(values.slice(0, -1))
          }
        }}
      />
    </div>
  )
}
