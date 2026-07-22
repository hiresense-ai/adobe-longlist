import { Outlet } from 'react-router-dom'
import { Navbar } from './Navbar'

export function AppLayout() {
  return (
    <div className="bg-muted/30 min-h-svh">
      <Navbar />
      <main className="app-container">
        <Outlet />
      </main>
    </div>
  )
}
