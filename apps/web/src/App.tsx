import { DiffWorkerPoolProvider } from './lib/workerPool.tsx';
import { useRoute } from './lib/router.ts';
import { ThemeProvider } from './state/ThemeContext.tsx';
import { Explore } from './components/Explore.tsx';
import { Homebase } from './components/Homebase.tsx';
import { ReviewWindow } from './components/ReviewWindow.tsx';

export function App(): React.JSX.Element {
  const route = useRoute();

  return (
    <DiffWorkerPoolProvider>
      <ThemeProvider>
        {route.name === 'homebase' ? (
          <Homebase />
        ) : route.name === 'explore' ? (
          <Explore />
        ) : (
          <ReviewWindow reviewId={route.reviewId} />
        )}
      </ThemeProvider>
    </DiffWorkerPoolProvider>
  );
}
