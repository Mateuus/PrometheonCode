import { redirect } from 'next/navigation';

/** A administração começa nos planos; não há painel próprio ainda. */
export default function AdminIndexPage() {
  redirect('/admin/plans');
}
