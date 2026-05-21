export {
  isSentryEnabled,
  sentryEnvironment,
  sentryRelease,
  baseSentryOptions,
  beforeSendEvent,
} from '@/lib/sentry/config'
export {
  captureStructuredEvent,
  captureException,
  capturePrismaError,
  captureHydrationError,
  setSentryUser,
  eventCategory,
  isCriticalErpEvent,
  type SentryCategory,
} from '@/lib/sentry/capture'
