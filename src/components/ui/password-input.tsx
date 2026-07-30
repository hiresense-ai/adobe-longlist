import { useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface PasswordInputProps extends Omit<
  ComponentProps<typeof Input>,
  'type'
> {
  /** Overrides the toggle button's colors — for surfaces like the Login
   * page that render a fixed dark theme independent of the app's own
   * light/dark toggle, where the default theme-aware colors would be
   * wrong. */
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
        Root cause of the unreliable clicks: this used size="icon-xs", a
        24x24px hit area — less than half the 44x44px minimum touch target
        (WCAG 2.5.5 / Apple HIG / Material Design all land on ~44-48px).
        That's small enough that a click anywhere near the visual edge of
        the icon, rather than dead center, misses the actual clickable
        element and lands on the input or the wrapper div instead — exactly
        "sometimes doesn't register" / "have to click around it".

        Fixed by sizing this button itself to size-11 (44x44), overriding
        the plain "icon" variant's default size-8. The icon glyph inside
        stays the normal 16px (Button's base [&_svg:not([class*='size-'])]
        rule, unchanged) — only the invisible clickable/hoverable box grows,
        which is the same pattern GitHub/Slack/Google use: a small glyph
        inside a generous tap target, not a literally 44px-tall icon.

        Everything else the click was ever routed through was already
        correct and needed no fix, confirmed by reading button.tsx's base
        class string directly:
          - pointer-events: base has `[&_svg]:pointer-events-none`, so a
            click can never land on the <svg> itself — only ever the
            <button>. Stroke-only icons (Eye/EyeOff have unfilled interior
            space) can't create the classic "gap in the middle of the icon
            eats the click" bug when the svg was never a valid hit target
            to begin with.
          - z-index / stacking: this button is `absolute`; the sibling
            <Input> is a plain static element. A positioned element always
            paints above an in-flow static sibling regardless of DOM order
            or z-index, so no explicit z-index was ever needed.
          - centering: Button's base class already has
            `inline-flex items-center justify-center`, so the icon is
            centered on both axes as soon as the button's own box is
            correctly sized — no extra flex/transform utilities needed here.
      */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className={cn(
          'text-muted-foreground hover:text-foreground absolute top-1/2 right-0.5 size-11 -translate-y-1/2',
          toggleClassName,
        )}
      >
        {visible ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  )
}

export { PasswordInput }
