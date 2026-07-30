import { PublicShell } from '@/components/layout/public-shell';
import { NotFoundState } from '@/components/states/screen-states';

export default function NotFound() {
  return (
    <PublicShell centered>
      <div className="w-full max-w-md">
        <NotFoundState backHref="/" />
      </div>
    </PublicShell>
  );
}
