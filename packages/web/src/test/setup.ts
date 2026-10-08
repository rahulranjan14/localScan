import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

/**
 * Unmount between tests.
 *
 * Testing Library registers this itself only when vitest runs with globals
 * enabled, which this project does not. Without it every render accumulates in
 * the same document and queries start matching leftovers from earlier tests --
 * which surfaces as "found multiple elements", or worse, as a query silently
 * resolving against a previous test's DOM.
 */
afterEach(cleanup)
