import { lazy, type ComponentType } from 'react'

/** Wraps React.lazy() for modules that use named exports instead of a default export. */
export function lazyNamed<T extends ComponentType<unknown>>(
  factory: () => Promise<Record<string, T>>,
  exportName: string,
) {
  return lazy(async () => {
    const loadedModule = await factory()
    return { default: loadedModule[exportName] }
  })
}
