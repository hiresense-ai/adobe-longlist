import { Suspense } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { RouterProvider } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'

import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PageFallback } from '@/components/common/PageFallback'
import { AuthProvider } from '@/context/AuthContext'
import { queryClient } from '@/lib/queryClient'
import { router } from '@/routes/router'

function App() {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TooltipProvider>
            <Suspense fallback={<PageFallback />}>
              <RouterProvider router={router} />
            </Suspense>
            <Toaster richColors position="top-right" closeButton />
          </TooltipProvider>
        </AuthProvider>
        {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
      </QueryClientProvider>
    </ThemeProvider>
  )
}

export default App
