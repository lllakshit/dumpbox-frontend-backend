import { DumpBoxApp } from "@/components/app/DumpBoxApp"
import { ServiceWorker } from "@/components/app/ServiceWorker"

export default function Home() {
  return (
    <>
      <DumpBoxApp />
      <ServiceWorker />
    </>
  )
}
