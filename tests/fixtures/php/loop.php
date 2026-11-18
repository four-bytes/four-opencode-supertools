<?php

class Looper
{
    public function run(array $items): void
    {
        foreach ($items as $item) {
            if ($item === null) {
                break;
            }
            echo $item;
        }
    }
}
