<?php

class Mutating
{
    public function run(array $items, string $subject): void
    {
        sort($items);
        preg_match('/x/', $subject, $matches);
        echo $items;
        echo $matches;
    }
}
