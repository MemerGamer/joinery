import { DiffWorkerPoolProvider } from './lib/workerPool.tsx';
import { useRoute } from './lib/router.ts';
import { ThemeProvider } from './state/ThemeContext.tsx';
import { Homebase } from './components/Homebase.tsx';
import { ReviewWindow } from './components/ReviewWindow.tsx';

export function App(): React.JSX.Element {
  const route = useRoute();

  return (
    <ThemeProvider>
      <DiffWorkerPoolProvider>
        {route.name === 'homebase' ? <Homebase /> : <ReviewWindow reviewId={route.reviewId} />}
      </DiffWorkerPoolProvider>
    </ThemeProvider>
  );
}
