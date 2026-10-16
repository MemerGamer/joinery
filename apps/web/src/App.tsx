import { DiffWorkerPoolProvider } from './lib/workerPool.tsx';
import { useRoute } from './lib/router.ts';
import { ThemeProvider } from './state/ThemeContext.tsx';
import { Homebase } from './components/Homebase.tsx';
import { ReviewWindow } from './components/ReviewWindow.tsx';
import { Settings } from './components/settings/Settings.tsx';

export function App(): React.JSX.Element {
  const route = useRoute();

  return (
    <DiffWorkerPoolProvider>
      <ThemeProvider>
        {route.name === 'homebase' ? (
          <Homebase />
        ) : route.name === 'settings' ? (
          <Settings />
        ) : (
          <ReviewWindow reviewId={route.reviewId} />
        )}
      </ThemeProvider>
    </DiffWorkerPoolProvider>
  );
}
