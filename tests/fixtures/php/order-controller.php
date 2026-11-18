<?php

namespace App\Controller;

class OrderController
{
    public function processOrder(int $orderId): string
    {
        $order = $this->repository->find($orderId);
        $this->assertPending($order);
        $this->repository->save($order);

        return $order->getId();
    }

    private function assertPending(Order $order): void
    {
        if ($order->getStatus() === 'pending') {
            $order->setStatus('processing');
        }
    }
}
