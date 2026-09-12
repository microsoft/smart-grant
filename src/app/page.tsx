import { redirect } from 'next/navigation';

// O produto e o /v2. A raiz existe so para nao deixar um link antigo em 404.
export default function Home() {
  redirect('/v2');
}
