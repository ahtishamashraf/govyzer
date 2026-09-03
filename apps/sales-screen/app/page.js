'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { readToken } from '@/lib/display-client';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(readToken() ? '/display' : '/pair');
  }, [router]);
  return null;
}
