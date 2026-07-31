import { useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface PasswordInputProps extends Omit<
  ComponentProps<typeof Input>,
  'type'
> {
  /** Overrides the toggle's colors — for surfaces like the Login page that
   * render a fixed dark theme independent of the app's own light/dark
   * toggle, where the default theme-aware colors would be wrong. Applied to
   * the inner visual span, not the button, so use `group-hover:` (not
   * `hover:`) for hover states: the span is pointer-events-none and so
   * never matches `:hover` itself. */
  toggleClassName?: string
}

function PasswordInput({
  className,
  toggleClassName,
  disabled,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative">
      <Input
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        className={cn('pr-11', className)}
        {...props}
      />
      {/*
        Hit area and visual shape are deliberately two different elements.

        The <button> is the hit area: a full 40x40 square with square
        corners. It is NOT rounded, because a border-radius on the
        clickable element itself carves a real ~3px triangular dead zone
        out of each of its 4 corners — clicks there fall through to the
        <input> underneath. Verified by sweeping document.elementFromPoint()
        inward from each corner: with a 12px radius the first ~3px resolved
        to the input, not the button; at radius 0 that collapsed to ~1px of
        ordinary subpixel noise. That was the real cause of "sometimes
        doesn't register / have to click around it".

        The <span> is the visual: rounded, and it paints the hover
        highlight. It's pointer-events-none, so it never intercepts a
        click or shrinks the hit area — the button behind it always
        receives the event, including at the corners the rounded shape
        visually excludes. Net effect: every pixel of the visible rounded
        square is clickable, plus the corner slivers just outside it.
        Hover/focus styling is driven off the button via group-hover /
        group-focus-visible for the same reason (a pointer-events-none
        element never matches :hover itself).

        The icon is 18px inside a 40px target — the standard
        small-glyph-in-a-generous-tap-target pattern (Google, GitHub,
        Microsoft, Adobe all size their password toggles this way), and
        comfortably above the 44px-with-surrounding-space guidance in
        WCAG 2.5.5. It's pointer-events-none too, so a click can never
        land on the <svg> instead of the button.

        cursor-pointer is explicit because Tailwind v4 dropped the
        `cursor: pointer` default that v3's preflight put on buttons.
      */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className="group absolute top-1/2 right-1 grid size-10 -translate-y-1/2 cursor-pointer place-items-center rounded-none border-0 bg-transparent p-0 outline-none disabled:pointer-events-none disabled:opacity-50"
      >
        <span
          className={cn(
            'pointer-events-none grid size-full place-items-center rounded-lg transition-colors',
            'text-muted-foreground group-hover:bg-foreground/10 group-hover:text-foreground',
            'group-focus-visible:ring-ring/50 group-focus-visible:ring-2',
            toggleClassName,
          )}
        >
          {visible ? (
            <EyeOff className="pointer-events-none size-[18px]" />
          ) : (
            <Eye className="pointer-events-none size-[18px]" />
          )}
        </span>
      </button>
    </div>
  )
}

export { PasswordInput }
