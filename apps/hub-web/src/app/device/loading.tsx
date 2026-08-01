import { ScreenLoading } from '@/components/states/screen-loading';

/**
 * A página consulta a Hub API antes de desenhar; este esqueleto ocupa o mesmo
 * lugar do card — centrado e estreito — para a troca não saltar.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-md flex-1 px-4 py-10">
      <ScreenLoading rows={3} />
    </div>
  );
}
