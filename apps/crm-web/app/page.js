import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const store = await cookies();
  redirect(store.get('gvz_at') ? '/dashboard' : '/login');
}
