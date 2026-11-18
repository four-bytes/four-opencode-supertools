<?php

class Nested
{
    public function run(array $rows): void
    {
        foreach ($rows as $row) {
            foreach ($row as $cell) {
                if ($cell === null) {
                    break 2;
                }
                echo $cell;
            }
        }
    }
}
